import { Controller, Get, Param, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { MediaService } from './media.service';

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get(':mediaId/url')
  getUrl(@Req() req: AuthenticatedRequest, @Param('mediaId') mediaId: string) {
    return this.media.getUrl(req.user.userId, mediaId);
  }
}
