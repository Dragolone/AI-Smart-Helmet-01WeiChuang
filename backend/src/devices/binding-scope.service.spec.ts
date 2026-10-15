// 用户可见范围（决策 #39）：只返回本人绑定区间内到达的数据；无区间时 where 片段匹配不到任何行。
import type { PrismaService } from '../prisma/prisma.service';
import { BindingScopeService } from './binding-scope.service';

const d = (iso: string) => new Date(iso);

describe('BindingScopeService', () => {
  const findMany = jest.fn();
  const svc = new BindingScopeService({
    deviceBinding: { findMany },
  } as unknown as PrismaService);

  it('intervals：按设备 + 用户查，绑定时间升序', async () => {
    findMany.mockResolvedValue([]);
    await svc.intervals('helmet_001', 'u1');
    expect(findMany).toHaveBeenCalledWith({
      where: { deviceId: 'helmet_001', userId: 'u1' },
      select: { boundAt: true, unboundAt: true },
      orderBy: { boundAt: 'asc' },
    });
  });

  it('scopeWhere：没有区间 → 只匹配 epoch 之前（等于什么都匹配不到）', () => {
    expect(svc.scopeWhere('receivedAt', [])).toEqual({
      OR: [{ receivedAt: { lt: new Date(0) } }],
    });
  });

  it('scopeWhere：已结束的区间带上下界，进行中的只带下界', () => {
    expect(
      svc.scopeWhere('createdAt', [
        {
          boundAt: d('2026-10-01T00:00:00Z'),
          unboundAt: d('2026-10-02T00:00:00Z'),
        },
        { boundAt: d('2026-10-05T00:00:00Z'), unboundAt: null },
      ]),
    ).toEqual({
      OR: [
        {
          createdAt: {
            gte: d('2026-10-01T00:00:00Z'),
            lte: d('2026-10-02T00:00:00Z'),
          },
        },
        { createdAt: { gte: d('2026-10-05T00:00:00Z') } },
      ],
    });
  });

  it('inScope：区间两端都算在内；区间外 / 两段之间不算；无区间一律不算', () => {
    const intervals = [
      {
        boundAt: d('2026-10-01T00:00:00Z'),
        unboundAt: d('2026-10-02T00:00:00Z'),
      },
      { boundAt: d('2026-10-05T00:00:00Z'), unboundAt: null },
    ];
    expect(svc.inScope(d('2026-10-01T00:00:00Z'), intervals)).toBe(true);
    expect(svc.inScope(d('2026-10-02T00:00:00Z'), intervals)).toBe(true);
    expect(svc.inScope(d('2026-10-03T00:00:00Z'), intervals)).toBe(false);
    expect(svc.inScope(d('2026-09-30T00:00:00Z'), intervals)).toBe(false);
    expect(svc.inScope(d('2099-01-01T00:00:00Z'), intervals)).toBe(true);
    expect(svc.inScope(d('2026-10-01T00:00:00Z'), [])).toBe(false);
  });
});
