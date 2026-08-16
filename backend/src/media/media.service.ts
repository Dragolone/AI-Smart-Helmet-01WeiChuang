import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MediaUrlResponse } from '@helmet/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../providers/storage.provider';

/** 预签名 URL 时效（API.md §9 ✅ 定稿 10 分钟）；测试用短时效验证过期窗口 */
const urlTtlSeconds = (): number => {
  const n = Number(process.env.MEDIA_URL_TTL_SECONDS);
  return Number.isInteger(n) && n > 0 ? n : 600;
};

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /** 换取有时效预签名 URL（§9）：归属 = 媒体所属设备的当前绑定用户，非本人一律 404 */
  async getUrl(userId: string, mediaId: string): Promise<MediaUrlResponse> {
    const media = await this.prisma.media.findUnique({
      where: { id: mediaId },
    });
    if (media) {
      const device = await this.prisma.device.findUnique({
        where: { deviceId: media.deviceId },
        select: { bindUserId: true },
      });
      if (device?.bindUserId === userId) {
        if (!media.storageKey) {
          throw new ConflictException({
            code: 'MEDIA_NOT_READY',
            message: '媒体尚未上传就绪',
          });
        }
        const ttl = urlTtlSeconds();
        const url = await this.storage.getSignedUrl(media.storageKey, ttl);
        return {
          url,
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        };
      }
    }
    // 不存在与无权访问同一响应，不泄露媒体存在性
    throw new NotFoundException({ code: 'NOT_FOUND', message: '媒体不存在' });
  }
}
