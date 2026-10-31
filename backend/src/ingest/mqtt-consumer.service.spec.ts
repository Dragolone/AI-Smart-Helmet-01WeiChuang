// MQTT 消费者单测：不连真 Broker——mqtt.connect 换成假客户端，直接驱动 handleMessage / 'connect' / SUBACK，
// 钉住「入库成功才签收」「订阅失败一直重连重试」「重试耗尽只告警不断连」这几条保命链路上的行为。
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';

jest.mock('mqtt', () => ({ connect: jest.fn() }));

import { connect } from 'mqtt';
import type { IngestService } from './ingest.service';
import {
  describeMqttError,
  MqttConsumerService,
} from './mqtt-consumer.service';

type Done = (err?: Error) => void;
type SubCb = (
  err: Error | null,
  granted?: Array<{ topic: string; qos: number }>,
) => void;
type PubCb = (err?: Error) => void;

class FakeClient extends EventEmitter {
  connected = true;
  handleMessage!: (packet: unknown, done: Done) => void;
  subscribe = jest.fn<void, [string[], { qos: number }, SubCb]>();
  publish = jest.fn<void, [string, string, { qos: number }, PubCb]>();
  endAsync = jest.fn(() => Promise.resolve());
  stream = { destroy: jest.fn() };
}

const connectMock = connect as unknown as jest.Mock;
const TOPICS = [
  'helmet/+/status',
  'helmet/+/location',
  'helmet/+/event',
  'helmet/+/cmd_ack',
];

const ENV_KEYS = [
  'MQTT_URL',
  'MQTT_BACKEND_CLIENT_ID',
  'MQTT_BACKEND_USERNAME',
  'MQTT_BACKEND_PASSWORD',
];

/** 让挂起的 Promise 链（processPublish → finally(done)）跑完 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const publishPacket = (topic: string, payload: string | Buffer) => ({
  cmd: 'publish',
  topic,
  payload:
    typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload,
  qos: 1,
});

describe('MqttConsumerService', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let client: FakeClient;
  let ingestRaw: jest.Mock;
  let service: MqttConsumerService;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    client = new FakeClient();
    connectMock.mockReset().mockReturnValue(client);
    ingestRaw = jest.fn(() => Promise.resolve('stored'));
    service = new MqttConsumerService({
      ingestRaw,
    } as unknown as IngestService);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /** 送一条消息进来，返回 done 的 mock（便于断言签收时机与是否带错） */
  const deliver = (packet: unknown): jest.Mock => {
    const done = jest.fn();
    client.handleMessage(packet, done);
    return done;
  };

  describe('连接参数', () => {
    it('未设环境变量：连 localhost:1883，固定 clientId backend_ingest + 持久会话 + 关掉自动重订阅', () => {
      service.onModuleInit();
      expect(connectMock).toHaveBeenCalledWith('mqtt://localhost:1883', {
        clientId: 'backend_ingest',
        clean: false,
        username: 'backend_ingest',
        password: undefined,
        resubscribe: false,
      });
    });

    it('环境变量覆盖 URL / clientId / 服务账号凭证', () => {
      process.env.MQTT_URL = 'mqtts://broker.example:8883';
      process.env.MQTT_BACKEND_CLIENT_ID = 'cid_x';
      process.env.MQTT_BACKEND_USERNAME = 'svc_user';
      process.env.MQTT_BACKEND_PASSWORD = 'svc_pass';
      service.onModuleInit();
      expect(connectMock).toHaveBeenCalledWith(
        'mqtts://broker.example:8883',
        expect.objectContaining({
          clientId: 'cid_x',
          username: 'svc_user',
          password: 'svc_pass',
          clean: false,
          resubscribe: false,
        }),
      );
    });

    it('连着的时候出错：立刻记一行、带错误码，不抛出', () => {
      service.onModuleInit();
      client.emit('connect', { sessionPresent: true });
      client.emit(
        'error',
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        'MQTT 错误：code=ECONNRESET read ECONNRESET',
      );
    });
  });

  describe('断线日志节流（O23）', () => {
    /** Node 对一个主机名的 IPv4 / IPv6 都试过后抛的错：message 为空，原因在 code 和里面每一条上 */
    const refused = () =>
      Object.assign(
        new AggregateError(
          [
            Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1883'), {
              code: 'ECONNREFUSED',
            }),
            { code: 'ECONNREFUSED', address: '::1', port: 1883 },
          ],
          '',
        ),
        { code: 'ECONNREFUSED' },
      );
    const REFUSED_TEXT =
      'code=ECONNREFUSED [connect ECONNREFUSED 127.0.0.1:1883; ECONNREFUSED ::1:1883]';
    const errorLines = () =>
      errorSpy.mock.calls.map((c) => String((c as [unknown])[0]));

    it('断线时记一行，断线期间每分钟汇总一行（带最近的错误码），恢复时记一行；不再每次重连都记', () => {
      jest.useFakeTimers({ now: 0 });
      service.onModuleInit();
      client.emit('connect', { sessionPresent: true });
      client.connected = false;
      client.emit('close');
      client.emit('offline');
      expect(errorLines()).toEqual([
        'MQTT 连接断开：没有错误信息（Broker 主动断开或网络中断）；每秒自动重连，断线期间每分钟汇总一行',
      ]);
      for (let i = 0; i < 150; i += 1) {
        jest.advanceTimersByTime(1000);
        client.emit('reconnect');
        client.emit('error', refused());
        client.emit('close');
      }
      expect(errorLines()).toHaveLength(3);
      expect(errorLines()[1]).toBe(
        `MQTT 仍未连上：已断 60 秒，重连 60 次，最近错误：${REFUSED_TEXT}`,
      );
      expect(errorLines()[2]).toBe(
        `MQTT 仍未连上：已断 120 秒，重连 120 次，最近错误：${REFUSED_TEXT}`,
      );
      expect(warnSpy).not.toHaveBeenCalled();

      client.connected = true;
      client.emit('connect', { sessionPresent: true });
      expect(logSpy).toHaveBeenCalledWith(
        'MQTT 已恢复：断线 150 秒，重连 150 次',
      );
      // 恢复后再断：重新开始算，新的一行带这次的原因
      client.emit(
        'error',
        Object.assign(new Error('Keepalive timeout'), { code: undefined }),
      );
      client.connected = false;
      client.emit('close');
      expect(errorLines().slice(3)).toEqual([
        'MQTT 错误：Keepalive timeout',
        'MQTT 连接断开：Keepalive timeout；每秒自动重连，断线期间每分钟汇总一行',
      ]);
    });

    it('启动时就连不上（错误先于 close 到）：写「连不上 Broker」并带上错误码，只记一行', () => {
      service.onModuleInit();
      client.connected = false;
      client.emit('error', refused());
      client.emit('close');
      client.emit('offline');
      expect(errorLines()).toEqual([
        `MQTT 连不上 Broker：${REFUSED_TEXT}；每秒自动重连，断线期间每分钟汇总一行`,
      ]);
    });

    it('订阅失败后主动掐断重连：断线那一行写明是自己断的', () => {
      jest.useFakeTimers();
      service.onModuleInit();
      client.emit('connect', { sessionPresent: true });
      const cb = client.subscribe.mock.calls[0][2];
      cb(new Error('Connection closed'));
      jest.advanceTimersByTime(5_000);
      client.connected = false;
      client.emit('close');
      expect(errorLines().at(-1)).toBe(
        'MQTT 连接断开：订阅失败后主动断开重连（Connection closed）；每秒自动重连，断线期间每分钟汇总一行',
      );
    });

    it('关停中断开：不算断线、不记日志', async () => {
      service.onModuleInit();
      client.emit('connect', { sessionPresent: true });
      await service.onModuleDestroy();
      client.connected = false;
      client.emit('close');
      client.emit('offline');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('describeMqttError：CONNACK 拒绝是数字原因码；非 Error 原样；换行压掉（防日志伪造）', () => {
      expect(
        describeMqttError(
          Object.assign(new Error('Connection refused: Not authorized'), {
            code: 5,
          }),
        ),
      ).toBe('code=5 Connection refused: Not authorized');
      expect(describeMqttError('boom')).toBe('boom');
      // 别的 realm 建的错误对象（instanceof Error 不成立，e2e 的 jest 沙箱里就是这样）：照样按字段取
      expect(
        describeMqttError({
          name: 'Error',
          message: 'connect ECONNREFUSED 127.0.0.1:1883',
          code: 'ECONNREFUSED',
        }),
      ).toBe('code=ECONNREFUSED connect ECONNREFUSED 127.0.0.1:1883');
      expect(describeMqttError({})).toBe('unknown error');
      expect(describeMqttError(new Error('a\nb'))).toBe('a b');
      expect(describeMqttError(new AggregateError([], ''))).toBe(
        'AggregateError',
      );
    });
  });

  describe('订阅与重试', () => {
    it('connect 后订阅四个设备 Topic（QoS1），SUBACK 全部放行即记「已订阅」、不再重试', () => {
      jest.useFakeTimers();
      service.onModuleInit();
      client.emit('connect', { sessionPresent: true });
      expect(client.subscribe).toHaveBeenCalledTimes(1);
      const [topics, opts, cb] = client.subscribe.mock.calls[0];
      expect(topics).toEqual(TOPICS);
      expect(opts).toEqual({ qos: 1 });
      cb(
        null,
        TOPICS.map((topic) => ({ topic, qos: 1 })),
      );
      expect(logSpy).toHaveBeenCalledWith(`已订阅：${TOPICS.join(', ')}`);
      jest.advanceTimersByTime(60_000);
      expect(client.subscribe).toHaveBeenCalledTimes(1);
    });

    it('SUBACK 没带 granted 且无错误：按成功处理', () => {
      service.onModuleInit();
      client.emit('connect', { sessionPresent: false });
      client.subscribe.mock.calls[0][2](null, undefined);
      expect(logSpy).toHaveBeenCalledWith(`已订阅：${TOPICS.join(', ')}`);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('订阅报错：5 秒后掐断连接让 mqtt.js 重连（重新认证），重连后再订，次数跨连接递增，直到成功为止', () => {
      jest.useFakeTimers();
      service.onModuleInit();
      client.emit('connect', { sessionPresent: false });
      client.subscribe.mock.calls[0][2](new Error('Unspecified error'));
      expect(errorSpy).toHaveBeenCalledWith(
        '订阅失败（第 1 次）：Unspecified error；5000ms 后断线重连再订',
      );
      jest.advanceTimersByTime(4_999);
      expect(client.stream.destroy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(client.stream.destroy).toHaveBeenCalledTimes(1);
      // 不在原连接上重订：没过认证的连接重订多少次都被拒
      expect(client.subscribe).toHaveBeenCalledTimes(1);

      client.emit('connect', { sessionPresent: true });
      expect(client.subscribe).toHaveBeenCalledTimes(2);
      client.subscribe.mock.calls[1][2](new Error('还是被拒'));
      expect(errorSpy).toHaveBeenLastCalledWith(
        '订阅失败（第 2 次）：还是被拒；5000ms 后断线重连再订',
      );
      jest.advanceTimersByTime(5_000);
      expect(client.stream.destroy).toHaveBeenCalledTimes(2);
      client.emit('connect', { sessionPresent: true });
      client.subscribe.mock.calls[2][2](null, [{ topic: TOPICS[0], qos: 1 }]);
      expect(logSpy).toHaveBeenLastCalledWith(`已订阅：${TOPICS.join(', ')}`);
      jest.advanceTimersByTime(60_000);
      expect(client.subscribe).toHaveBeenCalledTimes(3);
      expect(client.stream.destroy).toHaveBeenCalledTimes(2);

      // 成功后计数清零：下一次失败重新从第 1 次数
      client.emit('connect', { sessionPresent: false });
      client.subscribe.mock.calls[3][2](new Error('又失败'));
      expect(errorSpy).toHaveBeenLastCalledWith(
        '订阅失败（第 1 次）：又失败；5000ms 后断线重连再订',
      );
    });

    it('SUBACK 里有 qos=128（Broker 按 ACL 逐主题拒绝）：mqtt.js 不当错误，我们必须当失败重试并点名主题', () => {
      jest.useFakeTimers();
      service.onModuleInit();
      client.emit('connect', { sessionPresent: true });
      client.subscribe.mock.calls[0][2](null, [
        { topic: 'helmet/+/status', qos: 1 },
        { topic: 'helmet/+/location', qos: 128 },
        { topic: 'helmet/+/event', qos: 1 },
        { topic: 'helmet/+/cmd_ack', qos: 128 },
      ]);
      expect(errorSpy).toHaveBeenCalledWith(
        '订阅失败（第 1 次）：Broker 拒绝：helmet/+/location, helmet/+/cmd_ack；5000ms 后断线重连再订',
      );
      jest.advanceTimersByTime(5_000);
      expect(client.stream.destroy).toHaveBeenCalledTimes(1);
    });

    it('等重试期间断线重连（clientId 被顶替后 sessionPresent=false）：清掉旧计时器，不会把新连接再掐掉', () => {
      jest.useFakeTimers();
      service.onModuleInit();
      client.emit('connect', { sessionPresent: true });
      client.subscribe.mock.calls[0][2](new Error('瞬时失败'));
      // 计时器挂着的时候已经自己重新连上
      jest.advanceTimersByTime(2_000);
      client.emit('connect', { sessionPresent: false });
      expect(logSpy).toHaveBeenCalledWith(
        '已连接 MQTT Broker：mqtt://localhost:1883（sessionPresent=false）',
      );
      expect(client.subscribe).toHaveBeenCalledTimes(2);
      // 旧计时器原本会在 t=5000 掐断连接；被清掉后新连接不受影响
      jest.advanceTimersByTime(10_000);
      expect(client.stream.destroy).not.toHaveBeenCalled();
    });

    it('重连时没有挂起的重试：照样显式重新订阅（resubscribe:false 下不靠 mqtt.js 去重）', () => {
      service.onModuleInit();
      client.emit('connect', { sessionPresent: true });
      client.subscribe.mock.calls[0][2](null, [{ topic: TOPICS[0], qos: 1 }]);
      client.emit('connect', { sessionPresent: false });
      expect(client.subscribe).toHaveBeenCalledTimes(2);
    });

    it('关停中收到订阅失败：不再排重试', async () => {
      jest.useFakeTimers();
      service.onModuleInit();
      client.emit('connect', { sessionPresent: true });
      await service.onModuleDestroy();
      client.subscribe.mock.calls[0][2](new Error('连接已关闭'));
      expect(errorSpy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(60_000);
      expect(client.stream.destroy).not.toHaveBeenCalled();
    });
  });

  describe('关停', () => {
    it('有挂起的订阅重试：清掉计时器并 endAsync 关连接', async () => {
      jest.useFakeTimers();
      service.onModuleInit();
      client.emit('connect', { sessionPresent: true });
      client.subscribe.mock.calls[0][2](new Error('x'));
      await service.onModuleDestroy();
      expect(client.endAsync).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(60_000);
      expect(client.stream.destroy).not.toHaveBeenCalled();
    });

    it('从未初始化（没有客户端）也能安全关停', async () => {
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('消息处理（handleMessage 覆写）', () => {
    beforeEach(() => service.onModuleInit());

    it('非 publish 报文（如 pubrel）：直接 done，不进 Ingest', () => {
      const done = deliver({ cmd: 'pubrel', messageId: 1 });
      expect(done).toHaveBeenCalledWith();
      expect(ingestRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['status', 'helmet/helmet_001/status'],
      ['location', 'helmet/helmet_001/location'],
      ['event', 'helmet/helmet_001/event'],
    ])(
      '%s Topic：取 Topic 里的 deviceId，原文按 UTF-8 解码交给 Ingest（source=mqtt）',
      async (_kind, topic) => {
        const raw = '{"eventId":"e1","note":"摔倒✓"}';
        const done = deliver(publishPacket(topic, raw));
        await flush();
        expect(ingestRaw).toHaveBeenCalledWith(raw, 'helmet_001', 'mqtt');
        expect(done).toHaveBeenCalledWith();
        // 正常入库不逐条打日志（容器日志轮转会被刷掉），只记非常规结果
        expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(topic));
      },
    );

    it('入库成功才签收：Ingest 还没返回时不调 done（mqtt.js 据此才回 PUBACK）', async () => {
      let resolveIngest!: (v: string) => void;
      ingestRaw.mockImplementation(
        () =>
          new Promise<string>((r) => {
            resolveIngest = r;
          }),
      );
      const done = deliver(publishPacket('helmet/h1/event', '{}'));
      await flush();
      expect(ingestRaw).toHaveBeenCalledTimes(1);
      expect(done).not.toHaveBeenCalled();
      resolveIngest('duplicate');
      await flush();
      expect(done).toHaveBeenCalledWith();
      expect(logSpy).toHaveBeenCalledWith('[helmet/h1/event] → duplicate');
    });

    it('坏 JSON：消费者不自己解析，原样交给 Ingest（由 Ingest 落 _invalid 留档）', async () => {
      ingestRaw.mockResolvedValue('stored_invalid');
      const done = deliver(publishPacket('helmet/h1/event', '{not json'));
      await flush();
      expect(ingestRaw).toHaveBeenCalledWith('{not json', 'h1', 'mqtt');
      expect(done).toHaveBeenCalledWith();
      expect(logSpy).toHaveBeenCalledWith('[helmet/h1/event] → stored_invalid');
    });

    it('超大消息（70 KB）：不截断、不在消费层丢弃，完整交给 Ingest 判超限', async () => {
      const big = `{"pad":"${'x'.repeat(70 * 1024)}"}`;
      const done = deliver(publishPacket('helmet/h1/location', big));
      await flush();
      expect(ingestRaw).toHaveBeenCalledTimes(1);
      expect((ingestRaw.mock.calls[0] as [string])[0]).toHaveLength(big.length);
      expect(done).toHaveBeenCalledWith();
    });

    it.each([
      ['other/helmet_001/status'],
      ['helmet/helmet_001/cmd'],
      ['helmet/a/b/status'],
      ['helmet//status'],
      ['helmet/helmet_001/status/extra'],
    ])('未识别 Topic %p：告警后签收，不进 Ingest', async (topic) => {
      const done = deliver(publishPacket(topic, '{}'));
      await flush();
      expect(ingestRaw).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        `收到未识别 Topic 的消息，忽略：${topic}`,
      );
      expect(done).toHaveBeenCalledWith();
    });

    it('日志防伪造：Topic 里的换行进日志前被替换成空格', async () => {
      const done = deliver(publishPacket('evil\r\nFAKE LOG LINE', '{}'));
      await flush();
      expect(warnSpy).toHaveBeenCalledWith(
        '收到未识别 Topic 的消息，忽略：evil FAKE LOG LINE',
      );
      expect(done).toHaveBeenCalled();
    });

    it('入库瞬时失败：300ms 后重试，第二次成功即签收', async () => {
      jest.useFakeTimers();
      ingestRaw
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockResolvedValueOnce('stored');
      const done = deliver(publishPacket('helmet/h1/event', '{}'));
      await flush();
      expect(warnSpy).toHaveBeenCalledWith(
        '入库失败（第 1 次），300ms 后重试：connection reset',
      );
      expect(done).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(300);
      expect(ingestRaw).toHaveBeenCalledTimes(2);
      expect(done).toHaveBeenCalledWith();
    });

    it('入库重试耗尽（共 3 次）：只告警，done() 不带错（带错会断开连接丢更多消息）', async () => {
      jest.useFakeTimers();
      ingestRaw.mockRejectedValue(new Error('db down'));
      const done = deliver(publishPacket('helmet/h1/status', '{}'));
      await jest.advanceTimersByTimeAsync(1_000);
      expect(ingestRaw).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledWith(
        'Ingest 最终失败，该消息放弃 [helmet/h1/status]：db down',
      );
      expect(done).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledWith();
    });

    it('抛出非 Error 值也能记日志', async () => {
      jest.useFakeTimers();
      ingestRaw.mockRejectedValue('字符串错误');
      const done = deliver(publishPacket('helmet/h1/status', '{}'));
      await jest.advanceTimersByTimeAsync(1_000);
      expect(errorSpy).toHaveBeenCalledWith(
        'Ingest 最终失败，该消息放弃 [helmet/h1/status]：字符串错误',
      );
      expect(done).toHaveBeenCalledWith();
    });
  });

  describe('cmd_ack', () => {
    beforeEach(() => service.onModuleInit());

    it('处理器未注册：告警后签收，不进 Ingest（cmd_ack 不是事件 envelope）', async () => {
      const done = deliver(publishPacket('helmet/h1/cmd_ack', '{"a":1}'));
      await flush();
      expect(warnSpy).toHaveBeenCalledWith(
        'cmd_ack 处理器未注册，消息忽略：helmet/h1/cmd_ack',
      );
      expect(ingestRaw).not.toHaveBeenCalled();
      expect(done).toHaveBeenCalledWith();
    });

    it('处理器已注册：交给处理器（deviceId 取自 Topic），不进 Ingest', async () => {
      const handler = jest.fn(() => Promise.resolve());
      service.setCmdAckHandler(handler);
      const raw = '{"commandId":"c1","result":"success"}';
      const done = deliver(publishPacket('helmet/h9/cmd_ack', raw));
      await flush();
      expect(handler).toHaveBeenCalledWith('h9', raw);
      expect(ingestRaw).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        '[helmet/h9/cmd_ack] → ack_processed',
      );
      expect(done).toHaveBeenCalledWith();
    });

    it('回执事务瞬时失败：与入库同一套重试，第三次成功', async () => {
      jest.useFakeTimers();
      const handler = jest
        .fn<Promise<void>, [string, string]>()
        .mockRejectedValueOnce(new Error('advisory lock timeout'))
        .mockRejectedValueOnce(new Error('advisory lock timeout'))
        .mockResolvedValueOnce(undefined);
      service.setCmdAckHandler(handler);
      const done = deliver(publishPacket('helmet/h1/cmd_ack', '{}'));
      await jest.advanceTimersByTimeAsync(1_000);
      expect(handler).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledWith(
        'cmd_ack 处理失败（第 2 次），300ms 后重试：advisory lock timeout',
      );
      expect(logSpy).toHaveBeenCalledWith(
        '[helmet/h1/cmd_ack] → ack_processed',
      );
      expect(done).toHaveBeenCalledWith();
    });

    it('回执处理重试耗尽：告警放弃，仍签收且不带错', async () => {
      jest.useFakeTimers();
      const handler = jest.fn(() => Promise.reject(new Error('boom')));
      service.setCmdAckHandler(handler);
      const done = deliver(publishPacket('helmet/h1/cmd_ack', '{}'));
      await jest.advanceTimersByTimeAsync(1_000);
      expect(handler).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledWith(
        'Ingest 最终失败，该消息放弃 [helmet/h1/cmd_ack]：boom',
      );
      expect(done).toHaveBeenCalledWith();
    });
  });

  describe('publishCommand（命令下发）', () => {
    it('还没初始化（无客户端）：reject「MQTT 未连接」', async () => {
      await expect(service.publishCommand('h1', '{}')).rejects.toThrow(
        'MQTT 未连接',
      );
    });

    it('客户端断线中：reject，不调 publish（调用方据此留 pending）', async () => {
      service.onModuleInit();
      client.connected = false;
      await expect(service.publishCommand('h1', '{}')).rejects.toThrow(
        'MQTT 未连接',
      );
      expect(client.publish).not.toHaveBeenCalled();
    });

    it('已连接：发到 helmet/{deviceId}/cmd、QoS1，PUBACK 后 resolve', async () => {
      service.onModuleInit();
      client.publish.mockImplementation((_t, _p, _o, cb) => cb());
      await expect(
        service.publishCommand('h1', '{"commandId":"c1"}'),
      ).resolves.toBeUndefined();
      expect(client.publish).toHaveBeenCalledWith(
        'helmet/h1/cmd',
        '{"commandId":"c1"}',
        { qos: 1 },
        expect.any(Function),
      );
    });

    it('发布失败（回调带错）：reject 原错误', async () => {
      service.onModuleInit();
      client.publish.mockImplementation((_t, _p, _o, cb) =>
        cb(new Error('client disconnecting')),
      );
      await expect(service.publishCommand('h1', '{}')).rejects.toThrow(
        'client disconnecting',
      );
    });
  });
});
