import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../common/error-text';
import { sleep } from '../common/sleep';
import { withTimeout } from '../common/with-timeout';
import { helmetLabel, pushClock } from '../common/helmet-label';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_PROVIDER, type PushProvider } from '../providers/push.provider';
import {
  SMS_PROVIDER,
  maskPhone,
  type SmsMessage,
  type SmsProvider,
} from '../providers/sms.provider';
import { RealtimePushService } from '../realtime/realtime-push.service';
import type {
  Prisma,
  SosCase,
  SosNotification,
} from '../generated/prisma/client';
import {
  NOTIFICATION_STATUS,
  SOS_STATUS,
  maxNotifyAttempts,
  notifyDueAfterMs,
  notifyTimeoutMs,
} from './sos.constants';
import { toWireSos } from './sos-wire';

/** 短信 / 推送已发出、写 sent 时数据库瞬断：再试几次，别让一次瞬断把已发出的通知记成没发（到点会再发一条） */
const SENT_WRITE_RETRIES = 3;
const SENT_WRITE_RETRY_MS = 200;

/** 本人终态 Push 的标题按联系人短信的实际投递结果生成（审计 SOS-04：不能把「任务已创建」说成「已收到通知」） */
export const PUSH_TITLE = {
  contactsNotified: 'SOS 已通知紧急联系人',
  contactsFailed: 'SOS 紧急联系人通知发送失败',
  noContacts: 'SOS 未设置紧急联系人',
} as const;

/**
 * SOS 终态化与通知投递。confirm（SOS Now）、deadline 到期、pending 中设备再发 manual_sos
 * 三条路都走 finalizeNotified()——竞态安全全靠这里的条件更新。
 */
@Injectable()
export class SosNotifierService {
  private readonly logger = new Logger(SosNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimePushService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
  ) {}

  /**
   * pending → notified（条件更新，cancel/重复终态化的竞态只有一方赢），并在同一事务里
   * 铺好通知任务行——事务提交后即使进程崩溃，扫描任务也能按行续投，通知不丢。
   * 返回 false = 没抢到转换（已取消或已通知）。
   */
  async finalizeNotified(
    sosId: string,
    options: { deliverInline?: boolean | 'background' } = {},
  ): Promise<boolean> {
    const finalized = await this.prisma.$transaction(async (tx) => {
      const won = await tx.sosCase.updateMany({
        where: { id: sosId, status: SOS_STATUS.pending },
        data: { status: SOS_STATUS.notified, finalizedAt: new Date() },
      });
      if (won.count === 0) return null;

      const sosCase = await tx.sosCase.findUniqueOrThrow({
        where: { id: sosId },
      });
      const contacts = await tx.emergencyContact.findMany({
        where: { userId: sosCase.userId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      // 同号去重：两个联系人填同一手机号只发一条，避免同内容轰炸
      const seen = new Set<string>();
      for (const c of contacts) {
        if (seen.has(c.phone)) continue;
        seen.add(c.phone);
        await tx.sosNotification.create({
          data: {
            sosId,
            channel: 'sms',
            target: c.phone,
            contactName: c.name,
          },
        });
      }
      // 本人终态 Push 也走任务行（可重试留档）；WS 即时推送在事务外
      await tx.sosNotification.create({
        data: { sosId, channel: 'push', target: `user:${sosCase.userId}` },
      });
      return sosCase;
    });

    if (!finalized) return false;
    this.logger.warn(
      `SOS ${sosId} 已终态化 notified（device=${finalized.deviceId}），开始投递通知`,
    );
    this.realtime.pushSosUpdate(finalized.userId, toWireSos(finalized));
    // 扫描任务传 deliverInline=false：到期终态化只写库、不在这里等第三方，投递由扫描的独立阶段负责。
    // 内联首投的异常不能外抛（审计 SOS-06）：终态化已提交即视为成功，投递问题由扫描按通知行续投；
    // 否则 confirm 会给 App 回 500，而服务端其实已 notified，用户再点一次只会得到 409。
    // 'background'（App 的「立即求救」）：首投照样立刻开始，但不让 HTTP 响应等它——短信通道慢时
    // 内联首投按联系人逐条发，3 位 × 每条 9 s 要 18 s 才回，晚于 App 的超时，App 会在「已发送」页上弹「出错了」
    //（10-20 本地后端故障注入实测）。终态和通知行已在上面的事务里提交、WS 也已推出，响应不需要等投递
    if (options.deliverInline === 'background') {
      void this.deliverPending(sosId).catch((err: unknown) =>
        this.logger.error(
          `SOS ${sosId} 终态化后首轮投递异常（状态已 notified，由扫描续投）：${errorMessage(err)}`,
        ),
      );
      return true;
    }
    if (options.deliverInline !== false) {
      try {
        await this.deliverPending(sosId);
      } catch (err) {
        this.logger.error(
          `SOS ${sosId} 终态化后首轮投递异常（状态已 notified，由扫描续投）：${errorMessage(err)}`,
        );
      }
    }
    return true;
  }

  /**
   * 投递到点的通知行（pending/failed、attempts < 上限、且已过该次重试的等待；仅限已 notified 的 SOS）。
   * 扫描任务每轮也会调用——首投失败或进程崩溃后由这里续投；重试按退避节奏（决策 #50），不是每轮都投。
   * attempts 先占位再发送（条件更新防重叠扫描双发）：宁可少发一次，不可无限重发。
   */
  async deliverPending(sosId?: string): Promise<void> {
    const now = Date.now();
    // 每个 attempts 取值一条分支：首投无条件到点，第 n 次重试要等创建后累计等待已过
    const due: Prisma.SosNotificationWhereInput[] = Array.from(
      { length: maxNotifyAttempts() },
      (_, attempts) =>
        attempts === 0
          ? { attempts }
          : {
              attempts,
              createdAt: { lte: new Date(now - notifyDueAfterMs(attempts)) },
            },
    );
    const rows = await this.prisma.sosNotification.findMany({
      where: {
        ...(sosId ? { sosId } : {}),
        status: {
          in: [NOTIFICATION_STATUS.pending, NOTIFICATION_STATUS.failed],
        },
        OR: due,
        sos: { status: SOS_STATUS.notified },
      },
      include: { sos: true },
      // 顺序是业务约束不是口味：push 正文按「此刻短信的真实结果」生成（见 pushText），
      // 短信必须先投，否则用户会收到「短信全部失败，请直接拨打电话求助」而短信其实马上就成功了。
      // 两行在同一事务创建 → Postgres now() 取事务开始时间 → createdAt 完全相同，单按它排序
      // 区分不了先后（同 DBOPS-01 的缺少唯一次序键）。channel desc 把 'sms' 排在 'push' 前，
      // id 兜底保证全序稳定；take 也因此优先装满短信行。
      orderBy: [{ channel: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });

    for (const row of rows) {
      // 本人 Push 的正文按「此刻短信的真实结果」生成：同一单若还有短信行被另一路（内联首投 / 上一轮扫描）
      // 占位在飞（pending 且 attempts>0），现在读到的就是半截结果——这轮先不占，等下一轮（≤ 5 s）再发。
      // 否则 confirm 之后 0.5 s 内撞上扫描，用户会收到「短信全部失败，请直接拨打电话求助」，而短信随即就成功了
      if (row.channel === 'push') {
        const smsInFlight = await this.prisma.sosNotification.count({
          where: {
            sosId: row.sosId,
            channel: 'sms',
            status: NOTIFICATION_STATUS.pending,
            attempts: { gt: 0 },
          },
        });
        if (smsInFlight > 0) continue;
      }
      // 这一行本进程正在发（内联首投还没回来、扫描又到了这一行的重试时刻）：不再占第二次。
      // 原来在飞的那次还挂着时，扫描按 due 条件又占一次再发一条——联系人收两条，后回来的结果还会把 sent 盖成 failed（10-17 评审 SOS-2）
      if (this.inFlight.has(row.id)) continue;
      const claimed = await this.prisma.sosNotification.updateMany({
        where: {
          id: row.id,
          attempts: row.attempts,
          status: {
            in: [NOTIFICATION_STATUS.pending, NOTIFICATION_STATUS.failed],
          },
        },
        data: { attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue; // 另一轮扫描已抢走这一次投递
      this.inFlight.add(row.id);
      try {
        await this.deliverClaimed(row);
      } finally {
        this.inFlight.delete(row.id);
      }
    }
  }

  /** 本进程正在发送的通知行 id */
  private readonly inFlight = new Set<string>();

  /**
   * 发一次已占位的通知行并写结果。结果只写到「还是这次占位」的那一行（attempts 未被后来的重试改过）：
   * 迟到的旧结果不能盖掉新的。发送成功后写库失败另行重试，不能落进发送失败的分支——那会把已发出的短信记成失败、到点再发一条
   */
  private async deliverClaimed(row: SosNotification & { sos: SosCase }) {
    const thisAttempt = { id: row.id, attempts: row.attempts + 1 };
    try {
      // 挂起的第三方调用按失败记 lastError=…timeout，走既有重试，不占住扫描任务（审计 SOS-05）
      await withTimeout(
        this.send(row, row.sos),
        notifyTimeoutMs(),
        `sos.notify(${row.channel})`,
      );
    } catch (err) {
      const message = errorMessage(err);
      this.logger.error(
        `SOS 通知投递失败（第 ${row.attempts + 1} 次，channel=${row.channel}，target=${this.maskTarget(row)}）：${message}`,
      );
      await this.prisma.sosNotification.updateMany({
        where: thisAttempt,
        data: { status: NOTIFICATION_STATUS.failed, lastError: message },
      });
      return;
    }
    for (let i = 0; ; i += 1) {
      try {
        await this.prisma.sosNotification.updateMany({
          where: thisAttempt,
          // 重试成功后清掉上一次的错误：详情页不能同时显示「已发送」和旧错误文本（审计 SOS-08）
          data: {
            status: NOTIFICATION_STATUS.sent,
            sentAt: new Date(),
            lastError: null,
          },
        });
        return;
      } catch (err) {
        if (i >= SENT_WRITE_RETRIES) {
          // 写不进去就留在「占位未写结果」：到点会被当成没发重试（多一条，宁多勿漏），最后一次由 failInterrupted 收尾
          this.logger.error(
            `SOS 通知已发出但结果写库失败（channel=${row.channel}，target=${this.maskTarget(row)}）：${errorMessage(err)}`,
          );
          return;
        }
        await sleep(SENT_WRITE_RETRY_MS);
      }
    }
  }

  /**
   * 进程在「占位（attempts+1）」与「写结果」之间倒下、且那已是最后一次尝试的行，会永远停在 pending：
   * due 条件只覆盖 attempts < 上限，详情页永远显示「待发送」。扫描时把它们收尾成 failed，让失败可见。
   * 还有尝试次数的行不用管——它们到点会被 due 条件重新捞起。
   */
  async failInterrupted(): Promise<number> {
    const { count } = await this.prisma.sosNotification.updateMany({
      where: {
        status: NOTIFICATION_STATUS.pending,
        attempts: { gte: maxNotifyAttempts() },
      },
      data: {
        status: NOTIFICATION_STATUS.failed,
        lastError: 'interrupted: 最后一次投递中途进程退出，结果未知',
      },
    });
    if (count > 0) {
      this.logger.error(
        `SOS 通知行 ${count} 条在最后一次投递中途被中断，已记为 failed`,
      );
    }
    return count;
  }

  private async send(row: SosNotification, sosCase: SosCase): Promise<void> {
    if (row.channel === 'sms') {
      await this.sms.send(row.target, await this.smsMessage(sosCase));
      return;
    }
    // push target 形如 user:<id>。标题/正文按此刻联系人短信的真实结果生成：
    // 通知行按 channel desc 排序投递（见扫描处 orderBy 的说明），短信行在本人 Push 之前，所以这里读到的是本轮投递后的状态
    const { title, body } = await this.pushText(sosCase);
    // 已到终态：不带 "sos" 类别（那上面的「取消」按钮对已通知的单没有意义），只要时效性穿透专注模式
    await this.push.send(
      row.target.replace(/^user:/, ''),
      title,
      body,
      { sosId: sosCase.id, deviceId: sosCase.deviceId },
      { timeSensitive: true },
    );
  }

  /** 四层语义区分（审计 SOS-04）：任务已创建 ≠ Provider 已接收 ≠ 联系人已收到；文案只承诺前两者 */
  private async pushText(
    sosCase: SosCase,
  ): Promise<{ title: string; body: string }> {
    const sms = await this.prisma.sosNotification.findMany({
      where: { sosId: sosCase.id, channel: 'sms' },
      select: { status: true },
    });
    // 头盔写用户起的名字、时间写北京时间 HH:mm（原来是编号 + toISOString 的 UTC 原文，负责人 10-15）。
    // 名字只认这单主人起的：倒计时中解绑 / 换绑、或对账给前主人补建时，不能把新主人起的名字推给前主人（同 #215 activeForUser）
    const device = await this.prisma.device
      .findUnique({
        where: { deviceId: sosCase.deviceId },
        select: { name: true, bindUserId: true },
      })
      .catch(() => null);
    const helmet = helmetLabel({
      name: device?.bindUserId === sosCase.userId ? device.name : null,
      deviceId: sosCase.deviceId,
    });
    const clock = pushClock(sosCase.finalizedAt);
    const at = clock ? `已于 ${clock} ` : '';
    if (sms.length === 0) {
      return {
        title: PUSH_TITLE.noContacts,
        body: `头盔 ${helmet} 的求救${at}确认，但你尚未设置紧急联系人，无人会收到短信，请直接拨打电话求助`,
      };
    }
    const sent = sms.filter(
      (r) => r.status === NOTIFICATION_STATUS.sent,
    ).length;
    if (sent === 0) {
      return {
        title: PUSH_TITLE.contactsFailed,
        body: `头盔 ${helmet} 的求救${at}确认，向 ${sms.length} 位紧急联系人发送短信全部失败，系统会自动重试，请直接拨打电话求助`,
      };
    }
    return {
      title: PUSH_TITLE.contactsNotified,
      body: `头盔 ${helmet} 的求救${at}向 ${sent}/${sms.length} 位紧急联系人发出短信通知${sent < sms.length ? '（其余失败，系统会自动重试）' : ''}`,
    };
  }

  /**
   * SOS 通知消息：短信本身是固定文案、不带变量（决策 #46，腾讯云新建通知类模板禁止变量）；
   * 昵称 / 触发时间 / 位置照常算好放进 params，给后续带位置的渠道用（语音通知 / 分享链接）。
   * 昵称截 10 字、时间短格式沿用原变量限长口径，渠道接入时不用再改。
   */
  private async smsMessage(c: SosCase): Promise<SmsMessage> {
    const user = await this.prisma.user.findUnique({
      where: { id: c.userId },
      select: { nickname: true, phone: true },
    });
    // 没昵称时回落为脱敏手机号（11 字符，在腾讯云变量默认 12 字符限内；家属认得出号码，认不出 deviceId）
    const nickname =
      user?.nickname?.trim().slice(0, 10) ||
      (user ? maskPhone(user.phone) : c.deviceId.slice(0, 10));
    const at = c.finalizedAt ?? new Date();
    const triggeredAt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(at)
      .replace(/\//g, '-');
    const locationText =
      c.latitude !== null && c.longitude !== null
        ? `${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`
        : '暂不可用';
    return {
      template: 'sos_alert',
      params: { nickname, triggeredAt, locationText },
    };
  }

  /** 日志脱敏（Security Rules）：手机号打码；push target 本身不含敏感信息 */
  private maskTarget(row: SosNotification): string {
    return row.channel === 'sms' ? maskPhone(row.target) : row.target;
  }
}
