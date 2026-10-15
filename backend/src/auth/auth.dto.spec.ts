// 认证 DTO 校验（API.md §2）：手机号口径、6 位验证码、密码 8–72 字符且 ≤72 字节（bcrypt 只看前 72 字节，超出必须 400 而不是静默截断）。
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ChangePasswordDto,
  ChangePhoneDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
  SmsCodeDto,
} from './auth.dto';

const errorsOf = <T extends object>(cls: new () => T, body: object) =>
  validateSync(plainToInstance(cls, body)).map((e) => e.property);

const PHONE = '13800138000';
const ZH_25 = '密'.repeat(25); // 25 字符、75 字节

describe('auth DTO 校验', () => {
  it.each([
    ['13800138000', true],
    ['19912345678', true],
    ['12800138000', false], // 第二位不能是 2
    ['1380013800', false],
    ['138001380001', false],
    ['+8613800138000', false],
    [' 13800138000', false],
  ])('手机号 %p → %p', (phone, ok) => {
    expect(errorsOf(SmsCodeDto, { phone, purpose: 'register' })).toEqual(
      ok ? [] : ['phone'],
    );
  });

  it('发码用途只收白名单', () => {
    expect(errorsOf(SmsCodeDto, { phone: PHONE, purpose: 'register' })).toEqual(
      [],
    );
    expect(
      errorsOf(SmsCodeDto, { phone: PHONE, purpose: 'reset_password' }),
    ).toEqual([]);
    expect(
      errorsOf(SmsCodeDto, { phone: PHONE, purpose: 'change_phone' }),
    ).toEqual([]);
    expect(errorsOf(SmsCodeDto, { phone: PHONE, purpose: 'login' })).toEqual([
      'purpose',
    ]);
  });

  describe('RegisterDto', () => {
    const ok = { phone: PHONE, code: '123456', password: 'password1' };

    it('合法；昵称选填、≤30 字', () => {
      expect(errorsOf(RegisterDto, ok)).toEqual([]);
      expect(
        errorsOf(RegisterDto, { ...ok, nickname: '一'.repeat(30) }),
      ).toEqual([]);
      expect(
        errorsOf(RegisterDto, { ...ok, nickname: '一'.repeat(31) }),
      ).toEqual(['nickname']);
    });

    it.each([['12345'], ['1234567'], ['12345a'], [123456]])(
      '验证码 %p → 拒绝',
      (code) => {
        expect(errorsOf(RegisterDto, { ...ok, code })).toEqual(['code']);
      },
    );

    it('密码：7 字符拒、8 字符过、72 个 ASCII 过、73 个拒；25 个汉字（75 字节）按字节拒', () => {
      expect(errorsOf(RegisterDto, { ...ok, password: 'a'.repeat(7) })).toEqual(
        ['password'],
      );
      expect(errorsOf(RegisterDto, { ...ok, password: 'a'.repeat(8) })).toEqual(
        [],
      );
      expect(
        errorsOf(RegisterDto, { ...ok, password: 'a'.repeat(72) }),
      ).toEqual([]);
      expect(
        errorsOf(RegisterDto, { ...ok, password: 'a'.repeat(73) }),
      ).toEqual(['password']);
      expect(errorsOf(RegisterDto, { ...ok, password: ZH_25 })).toEqual([
        'password',
      ]);
      expect(
        errorsOf(RegisterDto, { ...ok, password: '密'.repeat(24) }),
      ).toEqual([]);
    });

    it('密码不是字符串：拒绝（MaxBytes 对非字符串也判失败）', () => {
      expect(errorsOf(RegisterDto, { ...ok, password: 12345678 })).toEqual([
        'password',
      ]);
    });
  });

  it('LoginDto：密码至少 1 字符、同样按字节封顶', () => {
    expect(errorsOf(LoginDto, { phone: PHONE, password: 'x' })).toEqual([]);
    expect(errorsOf(LoginDto, { phone: PHONE, password: '' })).toEqual([
      'password',
    ]);
    expect(errorsOf(LoginDto, { phone: PHONE, password: ZH_25 })).toEqual([
      'password',
    ]);
  });

  it('ResetPasswordDto / ChangePasswordDto：新密码与注册同规则', () => {
    expect(
      errorsOf(ResetPasswordDto, {
        phone: PHONE,
        code: '000000',
        newPassword: 'short',
      }),
    ).toEqual(['newPassword']);
    expect(
      errorsOf(ChangePasswordDto, { oldPassword: 'x', newPassword: ZH_25 }),
    ).toEqual(['newPassword']);
    expect(
      errorsOf(ChangePasswordDto, {
        oldPassword: 'x',
        newPassword: 'password1',
        refreshToken: '',
      }),
    ).toEqual(['refreshToken']);
    expect(
      errorsOf(ChangePasswordDto, {
        oldPassword: 'x',
        newPassword: 'password1',
      }),
    ).toEqual([]);
  });

  it('ChangePhoneDto：要当前密码 + 新号 + 验证码', () => {
    expect(
      errorsOf(ChangePhoneDto, {
        password: 'p',
        newPhone: PHONE,
        code: '123456',
      }),
    ).toEqual([]);
    expect(
      errorsOf(ChangePhoneDto, { newPhone: '123', code: '1' }).sort(),
    ).toEqual(['code', 'newPhone', 'password'].sort());
  });

  it('RefreshDto：非空字符串', () => {
    expect(errorsOf(RefreshDto, { refreshToken: 'rt' })).toEqual([]);
    expect(errorsOf(RefreshDto, { refreshToken: '' })).toEqual([
      'refreshToken',
    ]);
    expect(errorsOf(RefreshDto, {})).toEqual(['refreshToken']);
  });
});
