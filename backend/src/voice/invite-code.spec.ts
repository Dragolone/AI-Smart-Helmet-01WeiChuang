import {
  INVITE_CODE_ALPHABET,
  generateInviteCode,
  normalizeInviteCode,
} from './invite-code';

describe('邀请码（决策 #57）', () => {
  it('生成 6 位，只用 2–9 与去掉 I/L/O 的大写字母', () => {
    expect(INVITE_CODE_ALPHABET).toHaveLength(31);
    for (let i = 0; i < 500; i++) {
      const code = generateInviteCode();
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it('500 次不重复（31^6 ≈ 8.9 亿，碰撞概率可忽略；真撞车由 unique 约束 + 重试兜底）', () => {
    const seen = new Set(Array.from({ length: 500 }, generateInviteCode));
    expect(seen.size).toBe(500);
  });

  it('归一化：小写转大写；O→0、I/L→1 让旧数字码容错，新码不受影响', () => {
    expect(normalizeInviteCode('k7rm3x')).toBe('K7RM3X');
    expect(normalizeInviteCode('IOOIlO')).toBe('100110');
    expect(normalizeInviteCode('483921')).toBe('483921');
    const fresh = generateInviteCode();
    expect(normalizeInviteCode(fresh.toLowerCase())).toBe(fresh);
  });
});
