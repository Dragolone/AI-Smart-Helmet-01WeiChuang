import { Injectable, Logger } from '@nestjs/common';
import { sms } from 'tencentcloud-sdk-nodejs-sms';
import {
  maskPhone,
  type SmsMessage,
  type SmsProvider,
  type SmsTemplate,
} from './sms.provider';

const SmsClient = sms.v20210111.Client;
type SmsClientType = InstanceType<typeof SmsClient>;

export interface TencentSmsConfig {
  secretId: string;
  secretKey: string;
  sdkAppId: string;
  signName: string;
  /** 模板 ID（腾讯云控制台审核通过后的数字），按模板名映射 */
  templateIds: Record<SmsTemplate, string>;
  region?: string;
}

/** 从环境变量读取；任一必填项缺失返回 null → ProvidersModule 回落 Console Mock */
export const tencentSmsConfigFromEnv = (): TencentSmsConfig | null => {
  const secretId = process.env.TENCENT_SMS_SECRET_ID;
  const secretKey = process.env.TENCENT_SMS_SECRET_KEY;
  const sdkAppId = process.env.TENCENT_SMS_SDK_APP_ID;
  const signName = process.env.TENCENT_SMS_SIGN_NAME;
  const verifyCode = process.env.TENCENT_SMS_TEMPLATE_VERIFY_CODE;
  const sosAlert = process.env.TENCENT_SMS_TEMPLATE_SOS_ALERT;
  if (
    !secretId ||
    !secretKey ||
    !sdkAppId ||
    !signName ||
    !verifyCode ||
    !sosAlert
  ) {
    return null;
  }
  return {
    secretId,
    secretKey,
    sdkAppId,
    signName,
    templateIds: { verify_code: verifyCode, sos_alert: sosAlert },
    region: process.env.TENCENT_SMS_REGION || 'ap-guangzhou',
  };
};

/** 模板变量按腾讯云模板里 {1}{2}{3} 的顺序排列——顺序必须与控制台审核通过的模板一致 */
export const toTemplateParamSet = (m: SmsMessage): string[] => {
  switch (m.template) {
    case 'verify_code':
      return [m.params.code, String(m.params.ttlMinutes)];
    case 'sos_alert':
      return [m.params.nickname, m.params.triggeredAt, m.params.locationText];
  }
};

/** 腾讯云短信（SendSms，API 版本 2021-11-11）。国内号码统一加 +86 前缀。 */
@Injectable()
export class TencentSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TencentSmsProvider.name);
  private readonly client: SmsClientType;

  constructor(private readonly config: TencentSmsConfig) {
    this.client = new SmsClient({
      credential: {
        secretId: config.secretId,
        secretKey: config.secretKey,
      },
      region: config.region ?? 'ap-guangzhou',
      // reqTimeout 单位秒：SDK 默认 60s 会让发码请求跟着挂 1 分钟（审计 AUTH-11）；应用层另有 SMS_SEND_TIMEOUT_MS 兜底
      profile: {
        httpProfile: { endpoint: 'sms.tencentcloudapi.com', reqTimeout: 10 },
      },
    });
  }

  async send(phone: string, message: SmsMessage): Promise<void> {
    const res = await this.client.SendSms({
      PhoneNumberSet: [phone.startsWith('+') ? phone : `+86${phone}`],
      SmsSdkAppId: this.config.sdkAppId,
      SignName: this.config.signName,
      TemplateId: this.config.templateIds[message.template],
      TemplateParamSet: toTemplateParamSet(message),
    });
    const status = res.SendStatusSet?.[0];
    if (!status || status.Code !== 'Ok') {
      // 失败必须 throw（SmsProvider 契约）：SOS 通知据此记 failed 并重试
      throw new Error(
        `腾讯云短信发送失败：${status?.Code ?? 'NO_STATUS'} ${status?.Message ?? ''}`.trim(),
      );
    }
    this.logger.log(
      `短信已发送 → ${maskPhone(phone)} [${message.template}] serial=${status.SerialNo}`,
    );
  }
}
