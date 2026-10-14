import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EventDetail, EventListItem, Paginated } from '@helmet/shared';
import { BindingScopeService } from '../devices/binding-scope.service';
import { ensureDeviceOwned } from '../devices/device-access';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  INVALID_EVENT_TYPE,
  isKnownEventType,
  toWireEventDetail,
  toWireEventItem,
} from './event-wire';

/** 不存在、不是本人的、不在本人绑定区间内：同一个 404，不泄露事件存在性 */
const eventNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'NOT_FOUND', message: '事件不存在' });

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: BindingScopeService,
  ) {}

  /**
   * 事件历史（§6）：最新在前；type 多值逗号分隔且必须是 EVENTS.md §3 已知类型；
   * `_invalid` 占位事件永不出现在任何查询结果里。
   * 归属口径：设备须当前绑定给该用户（与 §4/§5 一致），且只返回该用户绑定区间内到达的事件（决策 #39）。
   */
  async list(
    userId: string,
    deviceId: string,
    opts: {
      type?: string;
      from?: string;
      to?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<Paginated<EventListItem>> {
    await ensureDeviceOwned(this.prisma, userId, deviceId);

    const types = this.parseTypes(opts.type);
    const timeRange = this.parseTimeRange(opts.from, opts.to);

    const intervals = await this.scope.intervals(deviceId, userId);
    const where: Prisma.RawEventWhereInput = {
      deviceId,
      eventType: types ? { in: types } : { not: INVALID_EVENT_TYPE },
      ...(timeRange ? { timestamp: timeRange } : {}),
      AND: [this.scope.scopeWhere('receivedAt', intervals)],
    };
    const [total, events] = await this.prisma.$transaction([
      this.prisma.rawEvent.count({ where }),
      this.prisma.rawEvent.findMany({
        where,
        // 同一时间戳可能有多条（头盔时间戳只到秒、补传整批到达）：加唯一次序键，翻页才不重不漏（同 DBOPS-01）
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
    ]);
    return {
      items: events.map(toWireEventItem),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  /** 事件详情（§6）：原样 payload + 关联媒体；归属按事件所属设备的当前绑定判定 */
  async detail(userId: string, eventId: string): Promise<EventDetail> {
    // eventId 只在设备内唯一（决策 #54）：按「本人当前绑定的设备」找，别人设备上同号的事件不在范围内。
    // 与列表同口径：非本人绑定设备、或不在本人绑定区间内的事件一律 404，不泄露存在性
    const owned = await this.prisma.device.findMany({
      where: { bindUserId: userId },
      select: { deviceId: true },
    });
    const event =
      owned.length === 0
        ? null
        : await this.prisma.rawEvent.findFirst({
            where: { eventId, deviceId: { in: owned.map((d) => d.deviceId) } },
          });
    if (!event || event.eventType === INVALID_EVENT_TYPE) {
      throw eventNotFound();
    }
    const intervals = await this.scope.intervals(event.deviceId, userId);
    if (!this.scope.inScope(event.receivedAt, intervals)) {
      throw eventNotFound();
    }
    // 关联媒体（§6/§9）：危险/摔倒事件反查 relatedEventId；video_ready 事件带自己那条
    // 限定同一设备：relatedEventId 是设备自报的字符串，别的设备可以填任意值，不能据此把它的媒体挂到本事件上（审计 MEDIA-01）
    const media = await this.prisma.media.findMany({
      where: {
        deviceId: event.deviceId,
        OR: [{ relatedEventId: eventId }, { eventId }],
      },
      orderBy: { createdAt: 'asc' },
    });
    return toWireEventDetail(
      event,
      media.map((m) => ({
        mediaId: m.id,
        status: m.status,
        duration: m.duration,
      })),
    );
  }

  private parseTypes(raw?: string): string[] | null {
    if (!raw?.trim()) return null;
    const types = raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (types.length === 0) return null;
    const unknown = types.filter((t) => !isKnownEventType(t));
    if (unknown.length > 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `未知事件类型：${unknown.join(', ')}`,
      });
    }
    return types;
  }

  /** from/to 均选填（与 §5 轨迹的必填不同——事件量级低，不设 24h 上限）；同时给出时须 from < to */
  private parseTimeRange(
    from?: string,
    to?: string,
  ): { gte?: Date; lte?: Date } | null {
    if (!from && !to) return null;
    const range: { gte?: Date; lte?: Date } = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    if (range.gte && range.lte && range.gte >= range.lte) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'from 必须早于 to',
      });
    }
    return range;
  }
}
