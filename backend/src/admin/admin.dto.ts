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
