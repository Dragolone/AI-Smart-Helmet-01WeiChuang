import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  LatestLocationResponse,
  LocationPoint as WireLocationPoint,
  Paginated,
} from '@helmet/shared';
import { PrismaService } from '../prisma/prisma.service';
import { toWireLocation } from './location-wire';

/** 单次轨迹查询时间范围上限（API.md §5 定稿：24h） */
const MAX_RANGE_MS = 24 * 60 * 60 * 1000;

const badRange = (message: string) =>
  new BadRequestException({ code: 'VALIDATION_FAILED', message });

/** 轨迹查询一律走本服务层，不裸查表——为未来 Retention/降采样留余地（CLAUDE.md Database Rules） */
@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async latest(deviceId: string): Promise<LatestLocationResponse> {
    const point = await this.prisma.locationPoint.findFirst({
      where: { deviceId },
      orderBy: { timestamp: 'desc' },
    });
    return { location: point ? toWireLocation(point) : null };
  }

  async listRange(
    deviceId: string,
    fromIso: string,
    toIso: string,
    page: number,
    pageSize: number,
  ): Promise<Paginated<WireLocationPoint>> {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (from.getTime() >= to.getTime()) {
      throw badRange('from 必须早于 to');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw badRange('单次查询时间范围不能超过 24 小时');
    }
    const where = { deviceId, timestamp: { gte: from, lte: to } };
    const [total, points] = await this.prisma.$transaction([
      this.prisma.locationPoint.count({ where }),
      this.prisma.locationPoint.findMany({
        where,
        // 轨迹回放按时间正序（API.md §5）
        orderBy: { timestamp: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: points.map(toWireLocation), total, page, pageSize };
  }
}
