import { Injectable } from '@nestjs/common';
import { ONLINE_WINDOW_MS } from '../devices/devices.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listUsers(page: number, pageSize: number, keyword?: string) {
    const kw = keyword?.trim();
    const where: Prisma.UserWhereInput = kw
      ? {
          OR: [
            { phone: { contains: kw } },
            { nickname: { contains: kw, mode: 'insensitive' } },
          ],
        }
      : {};
    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          phone: true,
          nickname: true,
          avatarUrl: true,
          createdAt: true,
          _count: { select: { devices: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: users.map((u) => ({
        id: u.id,
        phone: u.phone,
        nickname: u.nickname,
        avatarUrl: u.avatarUrl,
        createdAt: u.createdAt,
        deviceCount: u._count.devices,
      })),
      total,
      page,
      pageSize,
    };
  }

  async listDevices(
    page: number,
    pageSize: number,
    keyword?: string,
    online?: boolean,
  ) {
    const kw = keyword?.trim();
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);
    const conditions: Prisma.DeviceWhereInput[] = [];
    if (kw) {
      conditions.push({
        OR: [
          { deviceId: { contains: kw, mode: 'insensitive' } },
          { bindUser: { phone: { contains: kw } } },
        ],
      });
    }
    if (online === true) {
      conditions.push({ lastSeenAt: { gte: onlineSince } });
    } else if (online === false) {
      conditions.push({
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: onlineSince } }],
      });
    }
    const where: Prisma.DeviceWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};
    const [total, devices] = await this.prisma.$transaction([
      this.prisma.device.count({ where }),
      this.prisma.device.findMany({
        where,
        select: {
          deviceId: true,
          lastSeenAt: true,
          battery: true,
          charging: true,
          signalLevel: true,
          sleeping: true,
          firmwareVersion: true,
          boundAt: true,
          createdAt: true,
          bindUser: { select: { id: true, phone: true, nickname: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: devices.map((d) => ({
        deviceId: d.deviceId,
        // 与 DevicesService 同一口径（ONLINE_WINDOW_MS 单一来源）
        online: d.lastSeenAt !== null && d.lastSeenAt >= onlineSince,
        lastSeenAt: d.lastSeenAt,
        battery: d.battery,
        charging: d.charging,
        signalLevel: d.signalLevel,
        sleeping: d.sleeping,
        firmwareVersion: d.firmwareVersion,
        boundAt: d.boundAt,
        createdAt: d.createdAt,
        bindUser: d.bindUser,
      })),
      total,
      page,
      pageSize,
    };
  }
}
