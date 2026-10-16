import { envFlag } from './env';

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
