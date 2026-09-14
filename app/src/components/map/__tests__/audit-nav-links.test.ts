// 审计 2026-09-13 §8：导航跳转与位置分享的坐标系与 URL 正确性（决策 #32/#33）。
// 高德 URI 要求 GCJ-02（dev=0 表示已是高德坐标）；App 内一律先 toGcj02 再传。
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Linking, Platform } from 'react-native';
import type { Mock } from 'jest-mock';
import { openAmapNavigation } from '../nav-links';
import { toGcj02, wgs84ToGcj02 } from '../coords';

jest.mock('react-native', () => ({
  Linking: { openURL: jest.fn() },
  Platform: { OS: 'ios' },
}));
const openURL = Linking.openURL as unknown as Mock<(url: string) => Promise<void>>;

describe('导航跳转链接', () => {
  beforeEach(() => { openURL.mockReset(); openURL.mockResolvedValue(undefined); });

  it('iOS 用 iosamap scheme，带 dev=0（声明坐标已是 GCJ-02）', async () => {
    (Platform as { OS: string }).OS = 'ios';
    await openAmapNavigation({ longitude: 114.35, latitude: 22.69 }, '事故地点');
    const url = openURL.mock.calls[0][0] as string;
    expect(url).toMatch(/^iosamap:\/\/navi\?/);
    expect(url).toContain('dev=0');
    expect(url).toContain('lat=22.69');
    expect(url).toContain('lon=114.35');
  });

  it('Android 用 androidamap scheme', async () => {
    (Platform as { OS: string }).OS = 'android';
    await openAmapNavigation({ longitude: 114.35, latitude: 22.69 }, 'x');
    expect(openURL.mock.calls[0][0]).toMatch(/^androidamap:\/\/navi\?/);
  });

  it('未安装高德（openURL 抛错）时回落网页版，坐标顺序为 经度,纬度 且名称被编码', async () => {
    openURL.mockRejectedValueOnce(new Error('no app'));
    await openAmapNavigation({ longitude: 114.35, latitude: 22.69 }, '事故 地点&x');
    const fallback = openURL.mock.calls[1][0] as string;
    expect(fallback).toMatch(/^https:\/\/uri\.amap\.com\/navigation\?/);
    expect(fallback).toContain('to=114.35,22.69,');
    expect(fallback).toContain(encodeURIComponent('事故 地点&x'));
  });

  it('坐标层：wgs84 点先转 GCJ-02（与直接透传 gcj02 点不同）', () => {
    const wgs = { longitude: 114.35, latitude: 22.69, coordinateSystem: 'wgs84' as const };
    const gcj = { longitude: 114.35, latitude: 22.69, coordinateSystem: 'gcj02' as const };
    const a = toGcj02(wgs);
    const b = toGcj02(gcj);
    expect(a).toEqual(wgs84ToGcj02(114.35, 22.69));
    expect(b).toEqual({ longitude: 114.35, latitude: 22.69 });
    expect(a.longitude).not.toBeCloseTo(b.longitude, 5);
  });

  it('坐标层：gcj02 输入不得被二次偏移（重复调用幂等）', () => {
    const p = { longitude: 114.35, latitude: 22.69, coordinateSystem: 'gcj02' as const };
    const once = toGcj02(p);
    const twice = toGcj02({ ...once, coordinateSystem: 'gcj02' as const });
    expect(twice).toEqual(once);
  });
});
