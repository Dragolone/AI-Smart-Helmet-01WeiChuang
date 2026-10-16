// PrismaService：DATABASE_URL 缺失必须立刻失败（否则 pg 静默回退到 PG* 变量 / 本地 socket，第一次查询才报无关错误）。
// 只构造、不连库：PrismaPg 适配器在第一次查询时才建连接。
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  const saved = process.env.DATABASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  it.each([[undefined], ['']])(
    'DATABASE_URL=%p：构造即抛，提示看 .env.example',
    (v) => {
      if (v === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = v;
      expect(() => new PrismaService()).toThrow(/DATABASE_URL 未设置/);
    },
  );

  it('有连接串：构造成功（不建连接）；关停时断开', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/never_connected';
    const svc = new PrismaService();
    const spy = jest.spyOn(svc, '$disconnect').mockResolvedValue(undefined);
    await svc.onModuleDestroy();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
