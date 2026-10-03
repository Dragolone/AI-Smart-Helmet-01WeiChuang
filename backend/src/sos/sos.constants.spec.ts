import {
  maxNotifyAttempts,
  notifyDueAfterMs,
  notifyRetryDelaysMs,
  reconcileIntervalMs,
} from './sos.constants';

describe('SOS 通知重试退避（决策 #50）', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  beforeEach(() => {
    delete process.env.SOS_NOTIFY_RETRY_DELAYS_SECONDS;
    delete process.env.SOS_NOTIFY_MAX_ATTEMPTS;
    delete process.env.SOS_RECONCILE_INTERVAL_SECONDS;
  });

  it('默认：连首次 5 次，间隔 10 秒 / 1 分钟 / 5 分钟 / 15 分钟', () => {
    expect(maxNotifyAttempts()).toBe(5);
    expect(notifyRetryDelaysMs()).toEqual([10_000, 60_000, 300_000, 900_000]);
  });

  it('到点时间按创建时间累计：0 / 10 秒 / 70 秒 / 370 秒 / 1270 秒（约 21 分钟用完）', () => {
    expect([0, 1, 2, 3, 4].map(notifyDueAfterMs)).toEqual([
      0, 10_000, 70_000, 370_000, 1_270_000,
    ]);
  });

  it('次数上限调大后，表里没有的档位沿用最后一项（每 15 分钟）', () => {
    expect(notifyDueAfterMs(5)).toBe(1_270_000 + 900_000);
    expect(notifyDueAfterMs(7)).toBe(1_270_000 + 3 * 900_000);
  });

  it('环境变量覆盖：逗号分隔的非负整数秒，允许空格与 0', () => {
    process.env.SOS_NOTIFY_RETRY_DELAYS_SECONDS = '0';
    expect(notifyRetryDelaysMs()).toEqual([0]);
    expect(notifyDueAfterMs(4)).toBe(0);
    process.env.SOS_NOTIFY_RETRY_DELAYS_SECONDS = ' 5, 30 ,120';
    expect(notifyRetryDelaysMs()).toEqual([5000, 30_000, 120_000]);
  });

  it.each([['abc'], ['10,,60'], ['10,-1'], ['1.5'], [''], ['10s'], [',']])(
    '写错的值 %p → 整体回落默认，不会变成「立即重试」',
    (raw) => {
      process.env.SOS_NOTIFY_RETRY_DELAYS_SECONDS = raw;
      expect(notifyRetryDelaysMs()).toEqual([10_000, 60_000, 300_000, 900_000]);
    },
  );

  it('对账间隔默认 60 秒；非法值回落默认', () => {
    expect(reconcileIntervalMs()).toBe(60_000);
    process.env.SOS_RECONCILE_INTERVAL_SECONDS = '5';
    expect(reconcileIntervalMs()).toBe(5000);
    process.env.SOS_RECONCILE_INTERVAL_SECONDS = '0';
    expect(reconcileIntervalMs()).toBe(60_000);
  });
});
