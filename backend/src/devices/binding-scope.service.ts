import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** 一段绑定区间（unboundAt 为空 = 进行中） */
export interface BindingInterval {
  boundAt: Date;
  unboundAt: Date | null;
}

/**
 * 用户可见范围（决策 #39）：事件 / 轨迹 / 媒体只返回「该用户在该设备上的绑定区间内」到达的数据，
 * 以服务端 receivedAt/createdAt 判区间（设备时钟不可信，boundAt 也是服务端时间）。
 * 换绑后新主看不到前主期间的数据；同一人解绑再绑回来，两段历史都是他的。
 */
@Injectable()
export class BindingScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async intervals(
    deviceId: string,
    userId: string,
  ): Promise<BindingInterval[]> {
    return this.prisma.deviceBinding.findMany({
      where: { deviceId, userId },
      select: { boundAt: true, unboundAt: true },
      orderBy: { boundAt: 'asc' },
    });
  }

  /** Prisma where 片段：`{ OR: [{ field: { gte, lte } }, ...] }`；无区间时匹配不到任何行 */
  scopeWhere<F extends string>(
    field: F,
    intervals: BindingInterval[],
  ): { OR: Array<Record<F, { gte?: Date; lte?: Date; lt?: Date }>> } {
    if (intervals.length === 0) {
      return {
        OR: [{ [field]: { lt: new Date(0) } } as Record<F, { lt: Date }>],
      };
    }
    return {
      OR: intervals.map(
        (i) =>
          ({
            [field]: {
              gte: i.boundAt,
              ...(i.unboundAt ? { lte: i.unboundAt } : {}),
            },
          }) as Record<F, { gte: Date; lte?: Date }>,
      ),
    };
  }

  inScope(at: Date, intervals: BindingInterval[]): boolean {
    return intervals.some(
      (i) => at >= i.boundAt && (i.unboundAt === null || at <= i.unboundAt),
    );
  }
}
