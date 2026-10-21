import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { ContactsService } from '../contacts/contacts.service';
import { DevicesService } from '../devices/devices.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CLOSE_UNAUTHORIZED,
  RealtimeGateway,
} from '../realtime/realtime.gateway';
import { SOS_STATUS } from '../sos/sos.constants';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly devices: DevicesService,
    private readonly contacts: ContactsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * 注销账号（API.md §2，App Store 要求应用内可注销）：软删除留档，一个事务内完成——
   * 置 deletedAt、phone 改写为 deleted:<id>（释放号码供再注册，原号不保留）、清头像、
   * 删该号码的验证码记录（手机号在那张表里是明文）、撤销全部会话、解绑全部设备
   *（与 DELETE /devices/{id}/binding 同口径）、软删全部紧急联系人。
   * 事故/事件/轨迹等历史数据按设备留档不动。隐私政策（V1.2 起）「注销」一节按此写，改这里要同步改政策。
   *
   * 有进行中的求救 → 409 SOS_IN_PROGRESS，什么都不改（O15，负责人 10-21）：单子到点照常变「已通知」，
   * 联系人却已随注销删光，一条短信都发不出去。
   */
  async deleteAccount(userId: string, password: string): Promise<void> {
    await this.auth.verifyPassword(userId, password);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const { phone } = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { phone: true },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: now,
          phone: `deleted:${userId}`,
          avatarUrl: null,
        },
      });
      // 在更新用户行之后查：建单先给用户行加共享锁（sos-trigger createOrMerge），与这里的行锁互斥。
      // 建单先提交 → 这一句等它提交后执行，一定看得到那张单；注销先提交 → 建单看到已注销、不建。
      // 按建单时固化的 userId 查：头盔已解绑、单仍是本人的也算（同 GET /users/me/sos/active）
      const pending = await tx.sosCase.count({
        where: { userId, status: SOS_STATUS.pending },
      });
      if (pending > 0) {
        throw new ConflictException({
          code: 'SOS_IN_PROGRESS',
          message: '有正在倒计时的求救，处理完后再注销',
        });
      }
      await tx.smsCode.deleteMany({ where: { phone } });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.devices.unbindAll(userId, tx);
      await this.contacts.removeAll(userId, tx);
      // 退出全部对讲频道：否则幽灵成员一直占名额、留在成员列表里（审计 VOICE-02）；频道本身保留
      await tx.voiceChannelMember.deleteMany({ where: { userId } });
    });
    // 已建立的 WS 连接不能等 access token 自然过期再断（最长 15 分钟仍能收推送）
    const closed = this.realtime.closeUser(
      userId,
      CLOSE_UNAUTHORIZED,
      '账号已注销',
    );
    this.logger.log(
      `用户 ${userId} 已注销：会话撤销、设备解绑、联系人删除、退出频道、断开 ${closed} 个实时连接`,
    );
  }
}
