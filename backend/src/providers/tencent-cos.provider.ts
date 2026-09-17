import { Injectable, Logger } from '@nestjs/common';
import COS from 'cos-nodejs-sdk-v5';
import type { StorageProvider } from './storage.provider';

export interface TencentCosConfig {
  secretId: string;
  secretKey: string;
  /** 完整桶名（含 APPID 后缀），如 helmet-media-1415122735 */
  bucket: string;
  region: string;
}

/** 从环境变量读取；密钥或桶名任一缺失返回 null → ProvidersModule 回落 Mock（地域缺省广州，与服务器同区） */
export const tencentCosConfigFromEnv = (): TencentCosConfig | null => {
  const secretId = process.env.TENCENT_COS_SECRET_ID;
  const secretKey = process.env.TENCENT_COS_SECRET_KEY;
  const bucket = process.env.TENCENT_COS_BUCKET;
  if (!secretId || !secretKey || !bucket) return null;
  return {
    secretId,
    secretKey,
    bucket,
    region: process.env.TENCENT_COS_REGION || 'ap-guangzhou',
  };
};

/**
 * 腾讯云 COS（决策 #34）：为私有桶里的对象签发有时效的 GET 链接（API.md §9，默认 10 分钟）。
 * 签名在本地用子账号密钥计算，不发网络请求；链接过期或被篡改由 COS 侧拒绝（403）。
 * 桶必须为私有读写——签名链接是唯一访问途径。
 */
@Injectable()
export class TencentCosProvider implements StorageProvider {
  private readonly logger = new Logger(TencentCosProvider.name);
  private readonly cos: COS;

  constructor(private readonly config: TencentCosConfig) {
    this.cos = new COS({
      SecretId: config.secretId,
      SecretKey: config.secretKey,
      Protocol: 'https:',
    });
  }

  getSignedUrl(storageKey: string, expiresInSec: number): Promise<string> {
    // storageKey 由设备上报（EVENTS.md 4.9），COS 的对象键不以 / 开头；空键会签出整个桶根路径，必须拒绝
    const key = storageKey.replace(/^\/+/, '');
    if (!key) {
      return Promise.reject(new Error('storageKey 为空，无法签发链接'));
    }
    const expires = Math.max(1, Math.floor(expiresInSec));
    const url = this.cos.getObjectUrl({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
      Sign: true,
      Expires: expires,
    });
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return Promise.reject(new Error('COS 签名链接生成失败'));
    }
    // 链接里带签名，不进日志；只记对象键与时效
    this.logger.debug(`签发 COS 读取链接：${key}（${expires}s）`);
    return Promise.resolve(url);
  }
}
