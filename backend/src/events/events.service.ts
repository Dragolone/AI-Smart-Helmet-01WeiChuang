import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EventDetail, EventListItem, Paginated } from '@helmet/shared';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  INVALID_EVENT_TYPE,
  isKnownEventType,
  toWireEventDetail,
  toWireEventItem,
} from './event-wire';

const deviceNotFound = () =>
  new NotFoundException({
    code: 'DEVICE_NOT_FOUND',
    message: '设备不存在或未绑定到当前用户',
  });

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 事件历史（§6）：最新在前；type 多值逗号分隔且必须是 EVENTS.md §3 已知类型；
   * `_invalid` 占位事件永不出现在任何查询结果里。
   * 归属口径：按设备**当前绑定**判定（与 §4/§5 一致；raw_events 无 userId 冗余）。
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
    await this.ensureDeviceOwned(userId, deviceId);

    const types = this.parseTypes(opts.type);
    const timeRange = this.parseTimeRange(opts.from, opts.to);

    const where: Prisma.RawEventWhereInput = {
      deviceId,
      eventType: types ? { in: types } : { not: INVALID_EVENT_TYPE },
      ...(timeRange ? { timestamp: timeRange } : {}),
    };
    const [total, events] = await this.prisma.$transaction([
      this.prisma.rawEvent.count({ where }),
      this.prisma.rawEvent.findMany({
        where,
        orderBy: { timestamp: 'desc' },
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
    const event = await this.prisma.rawEvent.findUnique({
      where: { eventId },
    });
    if (!event || event.eventType === INVALID_EVENT_TYPE) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: '事件不存在' });
    }
    const device = await this.prisma.device.findUnique({
      where: { deviceId: event.deviceId },
      select: { bindUserId: true },
    });
    // 与列表同口径：非本人绑定设备的事件一律 404，不泄露存在性
    if (!device || device.bindUserId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: '事件不存在' });
    }
    // 关联媒体（§6/§9）：危险/摔倒事件反查 relatedEventId；video_ready 事件带自己那条
    const media = await this.prisma.media.findMany({
      where: { OR: [{ relatedEventId: eventId }, { eventId }] },
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

  private async ensureDeviceOwned(
    userId: string,
    deviceId: string,
  ): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
      select: { bindUserId: true },
    });
    if (!device || device.bindUserId !== userId) throw deviceNotFound();
  }
}
