import { jsonDepthExceeds } from './json-depth.guard';

const nest = (n: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
};

describe('jsonDepthExceeds', () => {
  it('标量 / 空对象 / 浅层对象不超限', () => {
    expect(jsonDepthExceeds(undefined, 3)).toBe(false);
    expect(jsonDepthExceeds('x', 3)).toBe(false);
    expect(jsonDepthExceeds({}, 3)).toBe(false);
    expect(jsonDepthExceeds({ a: [1, { b: 2 }] }, 3)).toBe(false);
  });

  it('恰好 limit 层不超、limit + 1 层超；数组与对象同样计层', () => {
    expect(jsonDepthExceeds(nest(5), 5)).toBe(false);
    expect(jsonDepthExceeds(nest(6), 5)).toBe(true);
    expect(jsonDepthExceeds([[[[[1]]]]], 5)).toBe(false);
    expect(jsonDepthExceeds([[[[[[1]]]]]], 5)).toBe(true);
  });

  it('只看最深的那一支：一支很深、其余很浅也判超；10 万层也不会把检查本身打爆', () => {
    expect(jsonDepthExceeds({ shallow: 1, deep: nest(10) }, 5)).toBe(true);
    expect(jsonDepthExceeds(nest(100_000), 2000)).toBe(true);
  });
});
