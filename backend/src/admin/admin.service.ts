import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ONLINE_WINDOW_MS } from '../devices/devices.service';
import {
  INVALID_EVENT_TYPE,
  buildSummary,
  isKnownEventType,
} from '../events/event-wire';
import { PrismaService } from '../prisma/prisma.service';
import { toWireAccident } from '../sos/sos-wire';
import type { Prisma } from '../generated/prisma/client';

/**
 * 关键词进 LIKE 前转义通配符：`%`/`_` 是 LIKE 元字符，Prisma 的 contains 不转义，
 * 搜 `%` 会命中全部行（审计 ADMIN-02）；PostgreSQL LIKE 默认转义字符是反斜杠。
 */
const escapeLike = (kw: string | undefined): string | undefined =>
  kw ? kw.replace(/[\\%_]/g, (m) => `\\${m}`) : kw;

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 用户列表（API.md §10）。已注销账号记录保留（事故归属/审计需要），但默认不列出、不计入总数
   *（口径 2026-09-15，审计 ADMIN-04）：运维查历史归属时用 includeDeleted=true 显式打开，行上带 deletedAt。
   */
  async listUsers(
    page: number,
    pageSize: number,
    keyword?: string,
    includeDeleted = false,
  ) {
    const kw = escapeLike(keyword?.trim());
    const where: Prisma.UserWhereInput = {
      ...(includeDeleted ? {} : { deletedAt: null }),
      ...(kw
        ? {
            OR: [
              { phone: { contains: kw } },
              { nickname: { contains: kw, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
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
          deletedAt: true,
          _count: { select: { devices: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
        deletedAt: u.deletedAt,
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
    const kw = escapeLike(keyword?.trim());
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
        orderBy: [{ createdAt: 'desc' }, { deviceId: 'desc' }],
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

  /** 事故/SOS 记录（API.md §10：状态/设备可筛，最新在前）；userId 无外键，归属用户单独批查 */
  async listAccidents(
    page: number,
    pageSize: number,
    status?: string,
    deviceId?: string,
  ) {
    const where: Prisma.SosCaseWhereInput = {
      ...(status ? { status } : {}),
      ...(deviceId?.trim() ? { deviceId: deviceId.trim() } : {}),
    };
    const [total, cases] = await this.prisma.$transaction([
      this.prisma.sosCase.count({ where }),
      this.prisma.sosCase.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const userIds = [...new Set(cases.map((c) => c.userId))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, phone: true, nickname: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      items: cases.map((c) => ({
        ...toWireAccident(c),
        user: byId.get(c.userId) ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** 设备详情 + 最近 10 条事件（含 _invalid，排查用）；不存在 404 */
  async getDeviceDetail(deviceId: string) {
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
      select: {
        deviceId: true,
        lastSeenAt: true,
        battery: true,
        charging: true,
        signalLevel: true,
        sleeping: true,
        firmwareVersion: true,
        settings: true,
        boundAt: true,
        createdAt: true,
        bindUser: { select: { id: true, phone: true, nickname: true } },
      },
    });
    if (!device) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: '设备不存在' });
    }
    const recent = await this.prisma.rawEvent.findMany({
      where: { deviceId },
      orderBy: { receivedAt: 'desc' },
      take: 10,
    });
    return {
      deviceId: device.deviceId,
      online: device.lastSeenAt !== null && device.lastSeenAt >= onlineSince,
      lastSeenAt: device.lastSeenAt,
      battery: device.battery,
      charging: device.charging,
      signalLevel: device.signalLevel,
      sleeping: device.sleeping,
      firmwareVersion: device.firmwareVersion,
      settings: device.settings ?? {},
      boundAt: device.boundAt,
      createdAt: device.createdAt,
      bindUser: device.bindUser,
      recentEvents: recent.map((e) => ({
        eventId: e.eventId,
        deviceId: e.deviceId,
        eventType: e.eventType,
        timestamp: e.timestamp,
        receivedAt: e.receivedAt,
        summary: buildSummary(
          e.eventType,
          e.payload as Record<string, unknown>,
        ),
        payload: e.payload,
        source: e.source,
        clockSkew: e.clockSkew,
        schemaVersion: e.schemaVersion,
      })),
    };
  }

  /** 概览统计（指标集定稿 2026-08-16）：「今日」= UTC+8 自然日；事件数不含 _invalid 留档 */
  async statsOverview() {
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);
    // 目标市场中国大陆（决策 #10）：自然日按固定 UTC+8 计算，与服务器时区无关
    const utc8 = new Date(Date.now() + 8 * 3600_000);
    utc8.setUTCHours(0, 0, 0, 0);
    const todayStart = new Date(utc8.getTime() - 8 * 3600_000);

    const [deviceTotal, deviceOnline, userTotal, todayEvents, activeSos] =
      await this.prisma.$transaction([
        this.prisma.device.count(),
        this.prisma.device.count({
          where: { lastSeenAt: { gte: onlineSince } },
        }),
        // 经营指标只计活跃账号；注销的壳记录（事故归属用）不算用户（口径 2026-09-15）
        this.prisma.user.count({ where: { deletedAt: null } }),
        this.prisma.rawEvent.count({
          where: {
            receivedAt: { gte: todayStart },
            eventType: { not: INVALID_EVENT_TYPE },
          },
        }),
        this.prisma.sosCase.count({ where: { status: 'pending' } }),
      ]);
    return {
      deviceTotal,
      deviceOnline,
      userTotal,
      todayEvents,
      activeSos,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 全量事件查询（API.md §10 ✅ 定稿 2026-08-16：不设独立端点，`invalid=true` 切换到
   * 校验失败留档视图）。Admin 是排查工具，故带 source/clockSkew（业务接口不可见的字段）。
   */
  async listEvents(
    page: number,
    pageSize: number,
    opts: {
      type?: string;
      deviceId?: string;
      from?: string;
      to?: string;
      invalid?: boolean;
    },
  ) {
    const types = opts.type
      ?.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (types?.length) {
      const unknown = types.filter((t) => !isKnownEventType(t));
      if (unknown.length > 0) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `未知事件类型：${unknown.join(', ')}`,
        });
      }
    }
    const timestamp: Prisma.DateTimeFilter = {};
    if (opts.from) timestamp.gte = new Date(opts.from);
    if (opts.to) timestamp.lte = new Date(opts.to);

    const where: Prisma.RawEventWhereInput = {
      ...(opts.deviceId?.trim() ? { deviceId: opts.deviceId.trim() } : {}),
      eventType: opts.invalid
        ? INVALID_EVENT_TYPE
        : types?.length
          ? { in: types }
          : { not: INVALID_EVENT_TYPE },
      ...(opts.from || opts.to ? { timestamp } : {}),
    };
    const [total, events] = await this.prisma.$transaction([
      this.prisma.rawEvent.count({ where }),
      this.prisma.rawEvent.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: events.map((e) => ({
        eventId: e.eventId,
        deviceId: e.deviceId,
        eventType: e.eventType,
        timestamp: e.timestamp,
        receivedAt: e.receivedAt,
        summary: buildSummary(
          e.eventType,
          e.payload as Record<string, unknown>,
        ),
        payload: e.payload,
        source: e.source,
        clockSkew: e.clockSkew,
        schemaVersion: e.schemaVersion,
      })),
      total,
      page,
      pageSize,
    };
  }
}
