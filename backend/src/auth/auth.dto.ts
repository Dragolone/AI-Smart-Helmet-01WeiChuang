import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SMS_CODE_PURPOSES, type SmsCodePurpose } from './sms-code.service';

const PHONE_PATTERN = /^1[3-9]\d{9}$/;
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
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  nickname?: string;
}

export class LoginDto {
  @Matches(PHONE_PATTERN, { message: 'phone 必须是有效的大陆手机号' })
  phone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
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
  newPassword!: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}
