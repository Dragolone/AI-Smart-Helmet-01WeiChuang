// 建单推送重试节奏 SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS：空串 = 不重试；写错 = 回落默认 5,20（不能因为拼错把重试关掉）。
import { createdPushRetryDelaysMs } from './sos.constants';

describe('createdPushRetryDelaysMs', () => {
  const saved = process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS;
  afterEach(() => {
    if (saved === undefined)
      delete process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS;
    else process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = saved;
  });

  it('未设：默认 5 秒、20 秒', () => {
    delete process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS;
    expect(createdPushRetryDelaysMs()).toEqual([5_000, 20_000]);
  });

  it('空串：不重试', () => {
    process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = '';
    expect(createdPushRetryDelaysMs()).toEqual([]);
  });

  it('合法值（允许空格）：按秒换算', () => {
    process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = ' 1, 2 ,3';
    expect(createdPushRetryDelaysMs()).toEqual([1_000, 2_000, 3_000]);
  });

  it.each([['5,abc'], ['-1,5'], ['1.5'], [','], ['5;20']])(
    '写错（%p）：整体回落默认 5,20',
    (raw) => {
      process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = raw;
      expect(createdPushRetryDelaysMs()).toEqual([5_000, 20_000]);
    },
  );
});
