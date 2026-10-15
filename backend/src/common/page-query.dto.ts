import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** 统一分页参数（API.md §1）：page 从 1 起，pageSize 1–100 默认 20；带其他筛选项的查询 DTO 继承它 */
export class PageQueryDto {
  // 上限 = int4 最大值：@IsInt 放过 1e20 这类「整数」，skip = (page-1)×pageSize 超出数据库 int8 → 500（边界测试 B1）
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
