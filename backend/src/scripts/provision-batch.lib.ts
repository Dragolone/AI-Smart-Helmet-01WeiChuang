/**
 * 批量开通的纯逻辑（无 IO），供 scripts/provision-batch.ts 与单测共用：
 * 参数解析、三件凭证的生成规则、批内与库内去重、CSV 拼装、二维码内容（DEVICE_PROTOCOL §11 格式 ①）。
 *
 * 生成规则与 scripts/provision-device.ts 单台开通完全一致——产线批量与开发期单台是同一套凭证：
 *   deviceId     = helmet_ + 6 位小写十六进制（13 字符；头盔 0x40 为 16 字节，放得下；后 6 位即广播名后缀）
 *   deviceSecret = 24 字节随机 base64url（32 字符，正好 0x50 的 32 字节；MVP BLE 链路不用，预留 4G）
 *   bindCode     = 8 位数字（App 手输友好；库内唯一）
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';

export const DEFAULT_QR_BASE = 'https://01weichuang.com/bind';
export const DEFAULT_OUT_DIR = 'provision-out';
export const MAX_BATCH = 500;

export interface BatchArgs {
  count: number;
  out: string;
  qrBase: string;
  qr: boolean;
}

export const USAGE =
  '用法：npm run provision:batch -w backend -- --count <1–500> [--out <目录>] [--qr-base <url>] [--no-qr]';

export function parseBatchArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): BatchArgs {
  let count: number | undefined;
  let out = DEFAULT_OUT_DIR;
  let qrBase = env.BIND_QR_BASE_URL?.trim() || DEFAULT_QR_BASE;
  let qr = true;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--count') {
      count = Number(argv[++i]);
    } else if (a === '--out') {
      out = argv[++i] ?? '';
    } else if (a === '--qr-base') {
      qrBase = argv[++i] ?? '';
    } else if (a === '--no-qr') {
      qr = false;
    } else {
      throw new Error(`未知参数 ${a}\n${USAGE}`);
    }
  }
  if (
    !Number.isInteger(count) ||
    count === undefined ||
    count < 1 ||
    count > MAX_BATCH
  ) {
    throw new Error(`--count 必须是 1–${MAX_BATCH} 的整数\n${USAGE}`);
  }
  if (!out) throw new Error(`--out 不能为空\n${USAGE}`);
  if (!/^https?:\/\/\S+$/.test(qrBase) || qrBase.includes('?')) {
    throw new Error(
      `--qr-base 必须是不带 query 的 http(s) 地址，如 ${DEFAULT_QR_BASE}\n${USAGE}`,
    );
  }
  return { count, out, qrBase: qrBase.replace(/\/+$/, ''), qr };
}

export const makeDeviceId = (): string =>
  `helmet_${randomBytes(3).toString('hex')}`;
export const makeDeviceSecret = (): string =>
  randomBytes(24).toString('base64url');
export const makeBindCode = (): string =>
  String(randomInt(10_000_000, 100_000_000));
export const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex');

/** BLE 广播名（DEVICE_PROTOCOL §1.2）：Helmet-<deviceId 后 6 位> */
export const broadcastName = (deviceId: string): string =>
  `Helmet-${deviceId.slice(-6)}`;

/** 绑定二维码内容（DEVICE_PROTOCOL §11 格式 ①）：App 内扫直接绑定，微信/相机扫落到网页 */
export const qrContent = (
  qrBase: string,
  deviceId: string,
  bindCode: string,
): string =>
  `${qrBase}?d=${encodeURIComponent(deviceId)}&c=${encodeURIComponent(bindCode)}`;

export interface ProvisionedDevice {
  deviceId: string;
  deviceSecret: string;
  bindCode: string;
  broadcastName: string;
  qrContent: string;
}

export interface Taken {
  deviceIds: Set<string>;
  bindCodes: Set<string>;
}

export interface Generators {
  deviceId: () => string;
  deviceSecret: () => string;
  bindCode: () => string;
}

const defaultGenerators: Generators = {
  deviceId: makeDeviceId,
  deviceSecret: makeDeviceSecret,
  bindCode: makeBindCode,
};

/**
 * 分配 count 台设备：deviceId 与 bindCode 既不与库中已有的重复，也不在本批内重复。
 * `taken` 会被就地扩充（分配一台记一台），调用方传入库里现有集合即可。
 */
export function allocateBatch(
  count: number,
  taken: Taken,
  qrBase: string,
  gen: Generators = defaultGenerators,
): ProvisionedDevice[] {
  const rows: ProvisionedDevice[] = [];
  const pick = (make: () => string, used: Set<string>): string => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const v = make();
      if (!used.has(v)) {
        used.add(v);
        return v;
      }
    }
    throw new Error(
      '连续 1000 次生成都撞上已有值，空间快用完了？请检查库里的设备数量',
    );
  };
  for (let i = 0; i < count; i += 1) {
    const deviceId = pick(gen.deviceId, taken.deviceIds);
    const bindCode = pick(gen.bindCode, taken.bindCodes);
    rows.push({
      deviceId,
      deviceSecret: gen.deviceSecret(),
      bindCode,
      broadcastName: broadcastName(deviceId),
      qrContent: qrContent(qrBase, deviceId, bindCode),
    });
  }
  return rows;
}

export const CSV_HEADER = [
  'deviceId',
  'deviceSecret',
  'bindCode',
  'broadcastName',
  'qrContent',
] as const;

const csvField = (v: string): string =>
  /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** 产线交接表：UTF-8、CRLF（Excel 直接打开不乱行）。含 deviceSecret，属敏感文件 */
export function buildCsv(rows: ProvisionedDevice[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(CSV_HEADER.map((k) => csvField(r[k])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
