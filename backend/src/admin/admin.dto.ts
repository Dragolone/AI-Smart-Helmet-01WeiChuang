import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class AdminLoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class AdminListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;
}

export class AdminDevicesQueryDto extends AdminListQueryDto {
  // query string 里只有字符串；服务层转布尔
  @IsOptional()
  @IsIn(['true', 'false'])
  online?: 'true' | 'false';
}

export class AdminAccidentsQueryDto extends AdminListQueryDto {
  @IsOptional()
  @IsIn(['pending', 'notified', 'cancelled'])
  status?: 'pending' | 'notified' | 'cancelled';

  @IsOptional()
  @IsString()
  @MaxLength(64)
  deviceId?: string;
}

export class AdminEventsQueryDto extends AdminListQueryDto {
  /** 逗号分隔多值（EVENTS.md §3 白名单，服务层校验） */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  deviceId?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  // invalid=true 只看校验失败的 _invalid 留档（排查用）；缺省排除
  @IsOptional()
  @IsIn(['true', 'false'])
  invalid?: 'true' | 'false';
}
