import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AllowNul } from '../common/nul.guard';
import { Public } from '../common/public.decorator';
import { EmqxHookService, type EmqxResult } from './emqx-hook.service';
import { InternalTokenGuard } from './internal-token.guard';

interface AuthenticateBody {
  clientid?: string;
  username?: string;
  password?: string;
}

interface AuthorizeBody {
  clientid?: string;
  username?: string;
  topic?: string;
  action?: string;
}

/** EMQX 内部回调：跳过用户 JWT（@Public），改用内部共享令牌校验来源。 */
@Public()
@AllowNul()
@UseGuards(InternalTokenGuard)
@Controller('internal/emqx')
export class EmqxHookController {
  constructor(private readonly hook: EmqxHookService) {}

  @Post('authenticate')
  @HttpCode(200)
  authenticate(@Body() body: AuthenticateBody): Promise<EmqxResult> {
    return this.hook.authenticate(body.username, body.password);
  }

  @Post('authorize')
  @HttpCode(200)
  authorize(@Body() body: AuthorizeBody): EmqxResult {
    return this.hook.authorize(body.username, body.topic, body.action);
  }
}
