import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  LatestLocationResponse,
  LocationPoint as WireLocationPoint,
  LocationSummaryResponse,
  Paginated,
  RidesResponse,
  TrackResponse,
} from '@helmet/shared';
import { latestPlausibleTime } from '../common/device-time';
import { BindingScopeService } from '../devices/binding-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { toWireLocation } from './location-wire';
import { MIN_RIDE_METERS, RIDE_MAX_MS, splitRides, thin } from './ride-split';
import { computeRideStats, type RideStats } from './ride-stats';

/** 单次轨迹查询时间范围上限（API.md §5 定稿：24h） */
const MAX_RANGE_MS = 24 * 60 * 60 * 1000;
/** 行程列表单次查询范围上限（API.md §5）：App 按自然月往前翻；夏令时结束的那个月比 31 天多 1 小时，所以给到 32 天 */
const MAX_RIDES_RANGE_MS = 32 * 24 * 60 * 60 * 1000;
/**
 * 行程列表往前多取这么长的点：判断 from 那一刻是不是正在一趟超长行程里（ride-split 的网格切分
 * 要看网格点之前 RIDE_MAX_MS 的点），也让起点在 from 之前的那一趟不被误当成从 from 开始。
 */
const RIDES_PAD_BEFORE_MS = RIDE_MAX_MS;
/** 往后多取这么长：一趟最长不到两个 RIDE_MAX_MS（起点不在网格点上时，到第二个网格点才切） */
const RIDES_PAD_AFTER_MS = 2 * RIDE_MAX_MS;

/**
 * 轨迹响应用到的列 = 线上 location 对象的全部字段，一个不多：id / eventId / deviceId 不进响应，
 * 一天最多 1.7 万点，每个点少读这三列就少传、少映射一遍。
 * satisfies：线上格式加了字段而这里漏了，编译期就报错，不会悄悄返回 undefined。
 */
const TRACK_SELECT = {
  latitude: true,
  longitude: true,
  coordinateSystem: true,
  accuracy: true,
  speed: true,
  heading: true,
  altitude: true,
  timestamp: true,
  receivedAt: true,
} satisfies Record<keyof WireLocationPoint, true>;

const toSummary = (s: RideStats): LocationSummaryResponse => ({
  distanceMeters: s.distanceMeters,
  movingSeconds: s.movingSeconds,
  maxSpeed: s.maxSpeed,
  pointCount: s.pointCount,
  firstAt: s.firstAt?.toISOString() ?? null,
  lastAt: s.lastAt?.toISOString() ?? null,
});

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
        timestamp: { lte: latestPlausibleTime() },
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
    return toSummary(computeRideStats(points));
  }

  /**
   * 行程列表（API.md §5）：起点落在 [from, to) 内的行程，最新在前。
   * 切分规则见 ride-split.ts。前后多取一段点，跨边界的那一趟才算得完整；
   * 它归到起点所在的区间，App 按月翻页时不重不漏。
   * 超长行程的网格以 from 为基准：App 每次都拿本地零点当 from，切点就都落在本地零点上。
   */
  async rides(
    userId: string,
    deviceId: string,
    fromIso: string,
    toIso: string,
  ): Promise<RidesResponse> {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (from.getTime() >= to.getTime()) {
      throw badRange('from 必须早于 to');
    }
    if (to.getTime() - from.getTime() > MAX_RIDES_RANGE_MS) {
      throw badRange('单次查询时间范围不能超过 32 天');
    }
    // 设备时钟跑到未来的点不参与：否则一条错误时间的点会让最后一趟一直「进行中」（同 latest 的口径）
    const upper = Math.min(
      to.getTime() + RIDES_PAD_AFTER_MS,
      latestPlausibleTime().getTime(),
    );
    const where = await this.rangeWhere(
      userId,
      deviceId,
      new Date(from.getTime() - RIDES_PAD_BEFORE_MS),
      new Date(upper),
    );
    const points = await this.prisma.locationPoint.findMany({
      where,
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      select: { latitude: true, longitude: true, speed: true, timestamp: true },
    });
    const rides = splitRides(points, new Date(), from)
      .map((span) => {
        const s = computeRideStats(points.slice(span.start, span.end + 1));
        return {
          startAt: points[span.start].timestamp,
          endAt: points[span.end].timestamp,
          distanceMeters: s.distanceMeters,
          movingSeconds: s.movingSeconds,
          maxSpeed: s.maxSpeed,
          ongoing: span.ongoing,
        };
      })
      .filter(
        (r) =>
          r.distanceMeters >= MIN_RIDE_METERS &&
          r.startAt.getTime() >= from.getTime() &&
          r.startAt.getTime() < to.getTime(),
      )
      .reverse()
      .map((r) => ({
        ...r,
        startAt: r.startAt.toISOString(),
        endAt: r.endAt.toISOString(),
      }));
    return { rides };
  }

  /**
   * 抽稀轨迹（API.md §5）：画线和回放用抽稀后的点，统计用全部的点。
   * 分页接口每页上限 100，App 自己拼到 1000 点后更长的行程会被截断。
   */
  async track(
    userId: string,
    deviceId: string,
    fromIso: string,
    toIso: string,
    maxPoints: number,
  ): Promise<TrackResponse> {
    const { from, to } = this.parseRange(fromIso, toIso);
    const where = await this.rangeWhere(userId, deviceId, from, to);
    const points = await this.prisma.locationPoint.findMany({
      where,
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      select: TRACK_SELECT,
    });
    return {
      points: thin(points, maxPoints).map(toWireLocation),
      total: points.length,
      summary: toSummary(computeRideStats(points)),
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
