import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { PHONE_PATTERN } from '../common/phone';
import { SMS_CODE_PURPOSES, type SmsCodePurpose } from './sms-code.service';

/** bcrypt 只看前 72 **字节**：MaxLength 按字符数算，72 个汉字 = 216 字节会被静默截断 */
const MAX_PASSWORD_BYTES = 72;
function MaxBytes(max: number, options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'maxBytes',
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} 不能超过 ${max} 字节`, ...options },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && Buffer.byteLength(value, 'utf-8') <= max,
      },
    });
  };
}

const CODE_PATTERN = /^\d{6}$/;

export class SmsCodeDto {
  @Matches(PHONE_PATTERN, { message: 'phone 必须是有效的大陆手机号' })
  phone!: string;

  @IsIn(SMS_CODE_PURPOSES)
  purpose!: SmsCodePurpose;
}

export class RegisterDto {
  @Matches(PHONE_PATTERN, { message: 'phone 必须是有效的大陆手机号' })
  phone!: string;

  @Matches(CODE_PATTERN, { message: 'code 必须是 6 位数字验证码' })
  code!: string;

  // bcrypt 输入上限 72 字节，超长部分会被静默截断，必须在入口挡住
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @MaxBytes(MAX_PASSWORD_BYTES)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  nickname?: string;
}

export class LoginDto {
  @Matches(PHONE_PATTERN, { message: 'phone 必须是有效的大陆手机号' })
  phone!: string;

  // 与注册同口径按字节挡（API.md §2「≤72 字节，超出 400」）：bcrypt 比较同样只看前 72 字节
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  @MaxBytes(MAX_PASSWORD_BYTES)
  password!: string;
}

export class ResetPasswordDto {
  @Matches(PHONE_PATTERN, { message: 'phone 必须是有效的大陆手机号' })
  phone!: string;

  @Matches(CODE_PATTERN, { message: 'code 必须是 6 位数字验证码' })
  code!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @MaxBytes(MAX_PASSWORD_BYTES)
  newPassword!: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  @MaxBytes(MAX_PASSWORD_BYTES)
  oldPassword!: string;

  // 新密码与注册/找回同规则：不按字节挡会被 bcrypt 静默截断成前 72 字节（审计 AUTH-02）
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @MaxBytes(MAX_PASSWORD_BYTES)
  newPassword!: string;

  // 当前设备的 refresh token：带上则改密后本设备免重新登录，其余会话一律撤销
  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;
}

export class ChangePhoneDto {
  // 当前密码：持有会话不等于本人（别人借用解锁的手机两分钟就能改号、再用新号找回密码夺走账号），
  // 与改密、注销同样要密码（2026-10-14）
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  @MaxBytes(MAX_PASSWORD_BYTES)
  password!: string;

  @Matches(PHONE_PATTERN, { message: 'newPhone 必须是有效的大陆手机号' })
  newPhone!: string;

  @Matches(CODE_PATTERN, { message: 'code 必须是 6 位数字验证码' })
  code!: string;
}
