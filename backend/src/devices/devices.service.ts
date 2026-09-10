import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

const notFound = () =>
  new NotFoundException({
    code: 'DEVICE_NOT_FOUND',
    message: '设备不存在或未绑定到当前用户',
  });

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async bind(userId: string, deviceId: string, bindCode: string) {
    const device = await this.prisma.device.findUnique({ where: { deviceId } });
    if (!device) throw notFound();
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
    const updated = await this.prisma.device.update({
      where: { deviceId },
      data: { bindUserId: userId, boundAt: new Date() },
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

  async getOwned(userId: string, deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
      select: DEVICE_PUBLIC_SELECT,
    });
    // 不存在与无权访问同一响应，不泄露设备存在性
    if (!device || device.bindUserId !== userId) throw notFound();
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

  async unbind(userId: string, deviceId: string): Promise<void> {
    await this.getOwned(userId, deviceId);
    // 只解除绑定关系；设备记录与历史事件留档（API.md §4）
    await this.prisma.device.update({
      where: { deviceId },
      data: { bindUserId: null, boundAt: null },
    });
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
   */
  async batteryHistory(userId: string, deviceId: string, hours: number) {
    await this.getOwned(userId, deviceId);
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3_600_000);
    const rows = await this.prisma.rawEvent.findMany({
      where: {
        deviceId,
        eventType: 'device_status',
        timestamp: { gte: from, lte: to },
      },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, payload: true },
      take: 5000,
    });
    const BUCKET_MS = 10 * 60_000;
    const buckets = new Map<
      number,
      { timestamp: string; battery: number; charging: boolean | null }
    >();
    for (const r of rows) {
      const payload = r.payload as {
        battery?: unknown;
        charging?: unknown;
      } | null;
      const battery =
        typeof payload?.battery === 'number' ? payload.battery : null;
      if (battery === null) continue;
      const key = Math.floor(r.timestamp.getTime() / BUCKET_MS);
      buckets.set(key, {
        timestamp: r.timestamp.toISOString(),
        battery: Math.max(0, Math.min(100, Math.round(battery))),
        charging:
          typeof payload?.charging === 'boolean' ? payload.charging : null,
      });
    }
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      points: [...buckets.values()],
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
