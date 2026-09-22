// 模板参数映射（THIRD_PARTY.md §4 / 决策 #46）：变量个数必须与腾讯云审核通过的模板一致，
// 多传或少传都会被腾讯云拒发——SOS 发不出去是保命链路事故，所以钉死。
import { renderSmsText, SOS_ALERT_TEXT } from './sms.provider';
import { toTemplateParamSet } from './tencent-sms.provider';

describe('toTemplateParamSet', () => {
  it('verify_code：{1} 验证码、{2} 有效分钟数，都是纯数字（验证码类变量限 6 位纯数字）', () => {
    const p = toTemplateParamSet({
      template: 'verify_code',
      params: { code: '097690', ttlMinutes: 5 },
    });
    expect(p).toEqual(['097690', '5']);
    expect(p.every((v) => /^\d{1,6}$/.test(v))).toBe(true);
  });

  it('sos_alert：固定文案模板，不传任何变量', () => {
    expect(
      toTemplateParamSet({
        template: 'sos_alert',
        params: {
          nickname: '张三',
          triggeredAt: '09-23 18:30',
          locationText: '22.54310,114.05790',
        },
      }),
    ).toEqual([]);
  });
});

describe('renderSmsText', () => {
  it('sos_alert 渲染为固定文案：不含昵称与坐标，日志也不再打印精确位置', () => {
    const text = renderSmsText({
      template: 'sos_alert',
      params: {
        nickname: '张三',
        triggeredAt: '09-23 18:30',
        locationText: '22.54310,114.05790',
      },
    });
    expect(text).toBe(SOS_ALERT_TEXT);
    expect(text).not.toContain('22.54310');
    expect(text).not.toContain('张三');
  });

  it('SOS 文案：不含链接、号码、【】，加签名【零一唯创】后不超过 70 字（按 1 条计费）', () => {
    expect(SOS_ALERT_TEXT).not.toMatch(/https?:|www\.|\d{7,}|【|】/);
    expect(`【零一唯创】${SOS_ALERT_TEXT}`.length).toBeLessThanOrEqual(70);
  });
});
