import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AllowNul } from '../common/nul.guard';
import { Public } from '../common/public.decorator';
import { EmqxHookService, type EmqxResult } from './emqx-hook.service';
import { InternalTokenGuard } from './internal-token.guard';

interface AuthenticateBody {
  clientid?: unknown;
  username?: unknown;
  password?: unknown;
}

interface AuthorizeBody {
  clientid?: unknown;
  username?: unknown;
  topic?: unknown;
  action?: unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

/** EMQX 内部回调：跳过用户 JWT（@Public），改用内部共享令牌校验来源。 */
@Public()
@AllowNul()
@UseGuards(InternalTokenGuard)
@Controller('internal/emqx')
export class EmqxHookController {
  constructor(private readonly hook: EmqxHookService) {}

  // body 没有 DTO 校验（EMQX 按模板只发字符串）：非字符串一律按缺失处理 → deny，
  // 否则数组 / 数字进 Prisma 查询或哈希会抛错变 500（边界测试 B8）
  @Post('authenticate')
  @HttpCode(200)
  authenticate(@Body() body: AuthenticateBody): Promise<EmqxResult> {
    return this.hook.authenticate(
      str(body?.username),
      str(body?.password),
      str(body?.clientid),
    );
  }

  @Post('authorize')
  @HttpCode(200)
  authorize(@Body() body: AuthorizeBody): EmqxResult {
    return this.hook.authorize(
      str(body?.username),
      str(body?.topic),
      str(body?.action),
    );
  }
}
