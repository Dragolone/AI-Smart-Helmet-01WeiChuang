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
    // 条件更新：并发绑定只有一方能把 null 改成自己，另一方如实拿到 409
    const won = await this.prisma.device.updateMany({
      where: { deviceId, bindUserId: null },
      data: { bindUserId: userId, boundAt: new Date() },
    });
    if (won.count === 0) {
      throw new ConflictException({
        code: 'DEVICE_ALREADY_BOUND',
        message: '设备已被其他用户绑定',
      });
    }
    const updated = await this.prisma.device.findUniqueOrThrow({
      where: { deviceId },
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
