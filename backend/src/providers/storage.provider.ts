import { Injectable, Logger } from '@nestjs/common';

/** DI token：云厂商 OSS/COS 就绪后换实现（预签名 URL 直传/直读，CLAUDE.md Provider 抽象） */
export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

export interface StorageProvider {
  /** 生成有时效的读取预签名 URL；失败必须 throw */
  getSignedUrl(storageKey: string, expiresInSec: number): Promise<string>;
}

/** Mock 实现：返回本地假 URL（第三方账号审核期不阻塞开发；本地联调可换 MinIO 实现） */
@Injectable()
export class MockStorageProvider implements StorageProvider {
  private readonly logger = new Logger('MockStorageProvider');

  getSignedUrl(storageKey: string, expiresInSec: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + expiresInSec;
    const url = `https://mock-storage.local/${storageKey}?expires=${expires}&signature=mock`;
    this.logger.log(
      `[MOCK STORAGE] 签发预签名 URL：${storageKey}（${expiresInSec}s）`,
    );
    return Promise.resolve(url);
  }
}
