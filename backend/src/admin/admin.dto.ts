import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../common/page-query.dto';

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

export class AdminListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;
}

export class AdminUsersQueryDto extends AdminListQueryDto {
  // 已注销账号默认不列出（口径 2026-09-15）；运维查历史事故归属时显式打开
  @IsOptional()
  @IsIn(['true', 'false'])
  includeDeleted?: 'true' | 'false';
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
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  // invalid=true 只看校验失败的 _invalid 留档（排查用）；缺省排除
  @IsOptional()
  @IsIn(['true', 'false'])
  invalid?: 'true' | 'false';
}
