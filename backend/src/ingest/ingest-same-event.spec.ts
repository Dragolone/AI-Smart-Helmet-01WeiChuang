import { sameEventPayload } from './ingest.service';

describe('sameEventPayload：同一次事件的两次上报', () => {
  it.each([
    ['完全相同', { a: 1, b: { c: 'x' } }, { a: 1, b: { c: 'x' } }],
    ['键顺序不同', { a: 1, b: 2 }, { b: 2, a: 1 }],
    [
      '库里是截短帧、新来的是完整帧',
      { confidence: 0.9 },
      {
        confidence: 0.9,
        impactG: 3.1,
        location: { latitude: 1, longitude: 2 },
      },
    ],
    [
      '库里是完整帧、新来的是截短帧',
      { confidence: 0.9, impactG: 3.1 },
      { confidence: 0.9 },
    ],
    ['原文 -0.0 进库读回是 0', { v: 0 }, { v: -0 }],
    ['空载荷是任何载荷的子集', {}, { pressDurationMs: 3000 }],
  ])('%s → 同一事件', (_name, stored, incoming) => {
    expect(sameEventPayload(stored, incoming)).toBe(true);
  });

  it.each([
    [
      '共有字段取值不同',
      { confidence: 0.9, impactG: 3.1 },
      { confidence: 0.9, impactG: 5.4 },
    ],
    [
      '嵌套对象里取值不同',
      { location: { latitude: 1, longitude: 2 } },
      { location: { latitude: 1, longitude: 3 } },
    ],
    ['数组不同（数组不做子集）', { ids: [1, 2] }, { ids: [1, 2, 3] }],
    ['对象换成标量', { location: { latitude: 1 } }, { location: 1 }],
    ['null 与对象', { location: null }, { location: { latitude: 1 } }],
  ])('%s → 另一件事', (_name, stored, incoming) => {
    expect(sameEventPayload(stored, incoming)).toBe(false);
  });
});
