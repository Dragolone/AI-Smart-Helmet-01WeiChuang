import { envFlag, MAX_TIMER_MS, timerMs } from './env';

describe('envFlag（开关类环境变量）', () => {
  const NAME = 'ENV_FLAG_SPEC';
  afterEach(() => {
    delete process.env[NAME];
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'On', ' true '])('%p → 开', (v) => {
    process.env[NAME] = v;
    expect(envFlag(NAME)).toBe(true);
  });

  it.each(['0', 'false', 'No', 'off', '', '  '])('%p → 关', (v) => {
    process.env[NAME] = v;
    expect(envFlag(NAME)).toBe(false);
  });

  it('未设 → 关', () => {
    expect(envFlag(NAME)).toBe(false);
  });

  it.each(['ture', '2', 'enabled'])(
    '认不出的 %p → 启动时报错（不静默当成关）',
    (v) => {
      process.env[NAME] = v;
      expect(() => envFlag(NAME)).toThrow(`${NAME}=`);
    },
  );
});

describe('timerMs（交给 setTimeout / setInterval 的毫秒数）', () => {
  it('超过 Node 计时器上限（约 24.8 天）的封顶：Node 会把超限值当成 1 ms，扫描空转、每条通知「1 ms 超时」', () => {
    expect(timerMs(5_000)).toBe(5_000);
    expect(timerMs(MAX_TIMER_MS)).toBe(MAX_TIMER_MS);
    expect(timerMs(3e9)).toBe(MAX_TIMER_MS);
  });
});
