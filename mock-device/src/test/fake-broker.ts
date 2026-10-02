// 测试用的最小 MQTT 3.1.1 Broker（node:net 手写，零依赖）：只实现 Mock 设备用到的
// CONNECT / SUBSCRIBE / PUBLISH(QoS0/1) / PINGREQ / DISCONNECT，把收到的东西记下来供断言。
// 用它而不是 stub mqtt 库：连的是真 TCP、走的是真 mqtt.js，clientId/Topic/QoS/回执都是线上实际字节。
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface BrokerConnect {
  clientId: string;
  username: string | null;
  password: string | null;
}
export interface BrokerPublish {
  topic: string;
  qos: number;
  payload: string;
}

const encodeLength = (n: number): Buffer => {
  const bytes: number[] = [];
  let rest = n;
  do {
    let b = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) b |= 0x80;
    bytes.push(b);
  } while (rest > 0);
  return Buffer.from(bytes);
};

export class FakeBroker {
  readonly connects: BrokerConnect[] = [];
  readonly subscribes: Array<{ topic: string; qos: number }> = [];
  readonly publishes: BrokerPublish[] = [];
  disconnects = 0;
  // 连接 → 它订阅的 Topic（只做精确匹配，Mock 不用通配符）
  private readonly sockets = new Map<net.Socket, Set<string>>();
  private readonly server = net.createServer((socket) => this.accept(socket));

  /** 监听本机随机端口，返回可直接给 MQTT_URL 的地址 */
  listen(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        resolve(`mqtt://127.0.0.1:${(this.server.address() as AddressInfo).port}`);
      });
    });
  }

  close(): Promise<void> {
    this.kick();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** 粗暴断开全部连接（模拟被同 clientId 顶替 / 网络闪断） */
  kick(): void {
    for (const s of this.sockets.keys()) s.destroy();
    this.sockets.clear();
  }

  /** 云 → 设备：只投给订阅了该 Topic 的连接；QoS 0 下发，省掉 PUBACK 往返 */
  publish(topic: string, payload: string): void {
    const t = Buffer.from(topic, 'utf-8');
    const body = Buffer.concat([Buffer.from([t.length >> 8, t.length & 0xff]), t, Buffer.from(payload, 'utf-8')]);
    const packet = Buffer.concat([Buffer.from([0x30]), encodeLength(body.length), body]);
    for (const [s, topics] of this.sockets) if (topics.has(topic)) s.write(packet);
  }

  publishesTo(topic: string): BrokerPublish[] {
    return this.publishes.filter((p) => p.topic === topic);
  }

  private accept(socket: net.Socket): void {
    this.sockets.set(socket, new Set());
    let buf: Buffer = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        // 剩余长度：变长编码，最多 4 字节
        let length = 0;
        let used = 0;
        let complete = false;
        while (1 + used < buf.length && used < 4) {
          const b = buf[1 + used];
          length += (b & 0x7f) * 128 ** used;
          used += 1;
          if ((b & 0x80) === 0) {
            complete = true;
            break;
          }
        }
        if (!complete || buf.length < 1 + used + length) return;
        const header = buf[0];
        const body = buf.subarray(1 + used, 1 + used + length);
        buf = buf.subarray(1 + used + length);
        this.handle(socket, header >> 4, header & 0x0f, body);
      }
    });
  }

  private handle(socket: net.Socket, type: number, flags: number, body: Buffer): void {
    let pos = 0;
    const readString = (): string => {
      const len = body.readUInt16BE(pos);
      const s = body.toString('utf-8', pos + 2, pos + 2 + len);
      pos += 2 + len;
      return s;
    };
    if (type === 1) {
      readString(); // 协议名
      pos += 1; // 协议级别
      const connectFlags = body[pos];
      pos += 3; // flags + keep alive
      const clientId = readString();
      if (connectFlags & 0x04) {
        readString();
        readString();
      }
      const username = connectFlags & 0x80 ? readString() : null;
      const password = connectFlags & 0x40 ? readString() : null;
      this.connects.push({ clientId, username, password });
      socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
    } else if (type === 8) {
      const packetId = body.subarray(0, 2);
      pos = 2;
      const granted: number[] = [];
      while (pos < body.length) {
        const topic = readString();
        const qos = body[pos];
        pos += 1;
        this.subscribes.push({ topic, qos });
        this.sockets.get(socket)?.add(topic);
        granted.push(qos);
      }
      socket.write(Buffer.concat([Buffer.from([0x90, 2 + granted.length]), packetId, Buffer.from(granted)]));
    } else if (type === 3) {
      const qos = (flags >> 1) & 0x03;
      const topic = readString();
      if (qos > 0) {
        socket.write(Buffer.concat([Buffer.from([0x40, 0x02]), body.subarray(pos, pos + 2)]));
        pos += 2;
      }
      this.publishes.push({ topic, qos, payload: body.toString('utf-8', pos) });
    } else if (type === 12) {
      socket.write(Buffer.from([0xd0, 0x00]));
    } else if (type === 14) {
      this.disconnects += 1;
    }
  }
}

/** 轮询等条件成立；超时抛错并带上说明，避免用固定 sleep 赌时序 */
export async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
