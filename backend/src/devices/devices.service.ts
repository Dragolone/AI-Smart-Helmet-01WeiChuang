import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BindingScopeService } from './binding-scope.service';
import { deviceNotFound } from './device-access';

/** 允许在调用方的事务里执行（注销账号时与其他清理原子提交） */
type DbClient = PrismaService | Prisma.TransactionClient;

/** 在线判定：lastSeenAt 距今 ≤ 90s（1.5 × 60s 心跳，DEVICE_PROTOCOL §5）。服务端权威，App 不自行判断。 */
export const ONLINE_WINDOW_MS = 90_000;

const DEVICE_PUBLIC_SELECT = {
  deviceId: true,
  name: true,
  bindCode: true,
  bindUserId: true,
  boundAt: true,
  lastSeenAt: true,
  battery: true,
  charging: true,
  signalLevel: true,
  sleeping: true,
  firmwareVersion: true,
  createdAt: true,
} as const;

type DevicePublic = {
  deviceId: string;
  name: string | null;
  bindCode: string | null;
  lastSeenAt: Date | null;
  battery: number | null;
  charging: boolean | null;
  signalLevel: number | null;
  sleeping: boolean;
  firmwareVersion: string | null;
  boundAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: BindingScopeService,
  ) {}

  async bind(userId: string, deviceId: string, bindCode: string) {
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
      select: DEVICE_PUBLIC_SELECT,
    });
    if (!device) throw deviceNotFound();
    if (!device.bindCode || device.bindCode !== bindCode) {
      throw new ForbiddenException({
        code: 'BIND_CODE_INVALID',
        message: '绑定码不正确',
      });
    }
    if (device.bindUserId === userId) {
      // 幂等：重复绑定自己的设备直接返回现状
      return this.toPublic(device);
    }
    if (device.bindUserId) {
      throw new ConflictException({
        code: 'DEVICE_ALREADY_BOUND',
        message: '设备已被其他用户绑定',
      });
    }
    const now = new Date();
    // 条件更新：并发绑定只有一方能把 null 改成自己，另一方如实拿到 409；
    // 同一事务开一段绑定历史（决策 #39：用户可见范围按绑定区间判定）
    const updated = await this.prisma.$transaction(async (tx) => {
      const won = await tx.device.updateMany({
        where: { deviceId, bindUserId: null },
        data: { bindUserId: userId, boundAt: now },
      });
      if (won.count === 0) {
        // 没抢到：可能是自己的另一个并发请求刚绑上（App 连点「绑定」）——那是幂等成功，
        // 不能回「设备已被其他用户绑定」（边界测试 B10；同 VOICE-01 同人并发加入频道）
        const current = await tx.device.findUniqueOrThrow({
          where: { deviceId },
          select: DEVICE_PUBLIC_SELECT,
        });
        if (current.bindUserId === userId) return current;
        throw new ConflictException({
          code: 'DEVICE_ALREADY_BOUND',
          message: '设备已被其他用户绑定',
        });
      }
      await tx.deviceBinding.create({
        data: { deviceId, userId, boundAt: now },
      });
      return tx.device.findUniqueOrThrow({
        where: { deviceId },
        select: DEVICE_PUBLIC_SELECT,
      });
    });
    return this.toPublic(updated);
  }

  async listMine(userId: string) {
    const devices = await this.prisma.device.findMany({
      where: { bindUserId: userId },
      select: DEVICE_PUBLIC_SELECT,
      orderBy: { boundAt: 'desc' },
    });
    return devices.map((d) => this.toPublic(d));
  }

  async getOwned(userId: string, deviceId: string, db: DbClient = this.prisma) {
    const device = await db.device.findUnique({
      where: { deviceId },
      select: DEVICE_PUBLIC_SELECT,
    });
    // 不存在与无权访问同一响应，不泄露设备存在性
    if (!device || device.bindUserId !== userId) throw deviceNotFound();
    return this.toPublic(device);
  }

  /** 重命名(API.md §4):trim 后空串=清除自定义名,App 回退显示 deviceId */
  async rename(userId: string, deviceId: string, name: string | null) {
    await this.getOwned(userId, deviceId);
    const trimmed = name?.trim() || null;
    const updated = await this.prisma.device.update({
      where: { deviceId },
      data: { name: trimmed },
      select: DEVICE_PUBLIC_SELECT,
    });
    return this.toPublic(updated);
  }

  async unbind(
    userId: string,
    deviceId: string,
    db: DbClient = this.prisma,
  ): Promise<void> {
    await this.getOwned(userId, deviceId, db);
    // 只解除绑定关系；设备记录与历史事件留档（API.md §4）；关闭当前这段绑定历史。
    // 两步必须同事务：外层已在事务里（注销账号）直接用 tx，否则自己开一个
    const now = new Date();
    const run = async (c: DbClient) => {
      // 带条件：归属检查到这里之间若自己的另一台手机已解绑、别人又绑上了，不能把别人的绑定抹掉；
      // 命中 0 行 = 已经不是自己的了，按幂等成功（10-06 并发评审 #5）
      // 自定义名一并清掉：那是上一位主人起的（如「张三的头盔」），下一位绑定后不该在列表里看到
      await c.device.updateMany({
        where: { deviceId, bindUserId: userId },
        data: { bindUserId: null, boundAt: null, name: null },
      });
      await c.deviceBinding.updateMany({
        where: { deviceId, userId, unboundAt: null },
        data: { unboundAt: now },
      });
    };
    if (db === this.prisma) {
      await this.prisma.$transaction((tx) => run(tx));
    } else {
      await run(db);
    }
  }

  /** 解绑该用户名下全部设备（注销账号用）：逐台走 unbind，口径与 DELETE /devices/{id}/binding 完全一致 */
  async unbindAll(userId: string, db: DbClient = this.prisma): Promise<void> {
    const bound = await db.device.findMany({
      where: { bindUserId: userId },
      select: { deviceId: true },
    });
    for (const { deviceId } of bound) {
      await this.unbind(userId, deviceId, db);
    }
  }

  async status(userId: string, deviceId: string) {
    const d = await this.getOwned(userId, deviceId);
    return {
      online: this.isOnline(d.lastSeenAt),
      lastSeenAt: d.lastSeenAt,
      battery: d.battery,
      charging: d.charging,
      signalLevel: d.signalLevel,
      sleeping: d.sleeping,
      firmwareVersion: d.firmwareVersion,
    };
  }

  /**
   * 电量历史（API.md §4）：从 raw_events 的 device_status 心跳里取 battery/charging，
   * 按 10 分钟桶取每桶最后一条（60s 心跳 → 24h 最多 144 点，App 画图够用又不拖流量）。
   * 只读原始事件表、不建新表：MVP 阶段 raw_events 即事实来源（EVENTS.md §2 原始留档）。
   *
   * 分桶在数据库里做：心跳周期可设到 1 秒（DEVICE_SETTINGS.heartbeatPeriod），7 天窗口的原始行数没有上界。
   * 原先取回前 5000 行再在内存分桶，60s 心跳下 7 天就有 10080 行——截掉的恰好是最近的一半。
   * 时间参数以 ISO 文本 + `::timestamp` 传入：列是不带时区的 UTC 时间，这样比较不受数据库会话时区影响。
   *
   * 电量只认 0–100 的整数，其余按缺失跳过——与设备快照（normalizeDeviceStatus）同口径。
   * 原先是截断取整：固件拿 255 表示「未知」时曲线上会画出一个 100%。
   * 判断写在 CASE 里：AND 两侧的求值顺序数据库不保证，直接转 numeric 遇到非数字会报错。
   */
  async batteryHistory(userId: string, deviceId: string, hours: number) {
    await this.getOwned(userId, deviceId);
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3_600_000);
    const window = { from: from.toISOString(), to: to.toISOString() };
    // 与事件/轨迹同口径（决策 #39）：只返回本人绑定区间内到达的心跳，换绑后不泄露前主期间的电量（审计 AUTH-06）
    const intervals = await this.scope.intervals(deviceId, userId);
    if (intervals.length === 0) return { ...window, points: [] };
    const inScope = Prisma.join(
      intervals.map((i) =>
        i.unboundAt
          ? Prisma.sql`(received_at >= ${i.boundAt.toISOString()}::timestamp AND received_at <= ${i.unboundAt.toISOString()}::timestamp)`
          : Prisma.sql`received_at >= ${i.boundAt.toISOString()}::timestamp`,
      ),
      ' OR ',
    );
    const rows = await this.prisma.$queryRaw<
      { ts_ms: number; battery: number; charging: unknown }[]
    >`
      SELECT DISTINCT ON (bucket) ts_ms, battery, charging
      FROM (
        SELECT
          (extract(epoch FROM "timestamp") * 1000)::float8 AS ts_ms,
          floor(extract(epoch FROM "timestamp") / 600) AS bucket,
          payload->'battery' AS battery,
          payload->'charging' AS charging
        FROM raw_events
        WHERE device_id = ${deviceId}
          AND event_type = 'device_status'
          AND "timestamp" >= ${window.from}::timestamp
          AND "timestamp" <= ${window.to}::timestamp
          AND CASE WHEN jsonb_typeof(payload->'battery') = 'number'
                   THEN (payload->'battery')::numeric BETWEEN 0 AND 100
                    AND (payload->'battery')::numeric = trunc((payload->'battery')::numeric)
                   ELSE false END
          AND (${inScope})
      ) heartbeats
      ORDER BY bucket, ts_ms DESC`;
    return {
      ...window,
      points: rows.map((r) => ({
        timestamp: new Date(r.ts_ms).toISOString(),
        battery: r.battery,
        charging: typeof r.charging === 'boolean' ? r.charging : null,
      })),
    };
  }

  private isOnline(lastSeenAt: Date | null): boolean {
    return (
      lastSeenAt !== null &&
      Date.now() - lastSeenAt.getTime() <= ONLINE_WINDOW_MS
    );
  }

  private toPublic(d: DevicePublic & { bindUserId?: string | null }) {
    return {
      deviceId: d.deviceId,
      name: d.name,
      // 绑定码只会经归属校验后的端点返回(list/detail/bind 均为本人),供 App 详情展示
      bindCode: d.bindCode,
      online: this.isOnline(d.lastSeenAt),
      lastSeenAt: d.lastSeenAt,
      battery: d.battery,
      charging: d.charging,
      signalLevel: d.signalLevel,
      sleeping: d.sleeping,
      firmwareVersion: d.firmwareVersion,
      boundAt: d.boundAt,
      createdAt: d.createdAt,
    };
  }
}
