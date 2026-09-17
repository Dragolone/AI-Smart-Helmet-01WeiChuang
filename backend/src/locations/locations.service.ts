import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  LatestLocationResponse,
  LocationPoint as WireLocationPoint,
  LocationSummaryResponse,
  Paginated,
} from '@helmet/shared';
import { BindingScopeService } from '../devices/binding-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { toWireLocation } from './location-wire';
import { computeRideStats } from './ride-stats';

/** 单次轨迹查询时间范围上限（API.md §5 定稿：24h） */
const MAX_RANGE_MS = 24 * 60 * 60 * 1000;

const badRange = (message: string) =>
  new BadRequestException({ code: 'VALIDATION_FAILED', message });

/** 轨迹查询一律走本服务层，不裸查表——为未来 Retention/降采样留余地（CLAUDE.md Database Rules） */
@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: BindingScopeService,
  ) {}

  /** 只看该用户绑定区间内的点（决策 #39）：换绑后前主的最后位置对新主不可见 */
  async latest(
    userId: string,
    deviceId: string,
  ): Promise<LatestLocationResponse> {
    const intervals = await this.scope.intervals(deviceId, userId);
    const point = await this.prisma.locationPoint.findFirst({
      where: {
        deviceId,
        AND: [this.scope.scopeWhere('receivedAt', intervals)],
      },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    });
    return { location: point ? toWireLocation(point) : null };
  }

  private parseRange(fromIso: string, toIso: string): { from: Date; to: Date } {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (from.getTime() >= to.getTime()) {
      throw badRange('from 必须早于 to');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw badRange('单次查询时间范围不能超过 24 小时');
    }
    return { from, to };
  }

  private async rangeWhere(
    userId: string,
    deviceId: string,
    from: Date,
    to: Date,
  ) {
    const intervals = await this.scope.intervals(deviceId, userId);
    return {
      deviceId,
      timestamp: { gte: from, lte: to },
      AND: [this.scope.scopeWhere('receivedAt', intervals)],
    };
  }

  /** 区间统计（API.md §5）：App 首页「今日骑行」用；一次取全区间点做几何累加，避免 App 翻页拼装 */
  async summaryRange(
    userId: string,
    deviceId: string,
    fromIso: string,
    toIso: string,
  ): Promise<LocationSummaryResponse> {
    const { from, to } = this.parseRange(fromIso, toIso);
    const where = await this.rangeWhere(userId, deviceId, from, to);
    const points = await this.prisma.locationPoint.findMany({
      where,
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      select: { latitude: true, longitude: true, speed: true, timestamp: true },
    });
    const s = computeRideStats(points);
    return {
      distanceMeters: s.distanceMeters,
      movingSeconds: s.movingSeconds,
      maxSpeed: s.maxSpeed,
      pointCount: s.pointCount,
      firstAt: s.firstAt?.toISOString() ?? null,
      lastAt: s.lastAt?.toISOString() ?? null,
    };
  }

  async listRange(
    userId: string,
    deviceId: string,
    fromIso: string,
    toIso: string,
    page: number,
    pageSize: number,
  ): Promise<Paginated<WireLocationPoint>> {
    const { from, to } = this.parseRange(fromIso, toIso);
    const where = await this.rangeWhere(userId, deviceId, from, to);
    const [total, points] = await this.prisma.$transaction([
      this.prisma.locationPoint.count({ where }),
      this.prisma.locationPoint.findMany({
        where,
        // 轨迹回放按时间正序（API.md §5）
        // 同一时间戳可能有多点：加唯一次序键，跨页/跨执行计划的页序才稳定（审计 DBOPS-01）
        orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: points.map(toWireLocation), total, page, pageSize };
  }
}
