// 4G 链路（MQTT）传输此前没有单测。这里用假 Broker 走真 TCP + 真 mqtt.js，钉住 DEVICE_PROTOCOL §3/§4/§7：
// 认证身份、Topic 与 QoS、命令回执三态、畸形命令不回执也不掉线、重连后重新订阅并再次 onReady。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { EventEnvelope, EventType } from '@helmet/shared';
import { buildEnvelope } from './envelope.ts';
import { createMqttTransport, type CmdResult } from './mqtt-transport.ts';
import { FakeBroker, waitFor } from './test/fake-broker.ts';
import type { Transport } from './transport.ts';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('mqtt-transport', () => {
  const broker = new FakeBroker();
  let url = '';
  const running: Transport[] = [];

  before(async () => {
    url = await broker.listen();
  });

  after(async () => {
    await Promise.all(running.map((t) => new Promise<void>((resolve) => t.stop(resolve))));
    await broker.close();
  });

  const connect = async (
    deviceId: string,
    cmdResult: CmdResult = 'success',
  ): Promise<{ transport: Transport; logs: string[]; ready: () => number }> => {
    const logs: string[] = [];
    let readyCount = 0;
    const transport = createMqttTransport({
      url,
      deviceId,
      deviceSecret: `secret_of_${deviceId}`,
      cmdResult,
      log: (m) => logs.push(m),
    });
    running.push(transport);
    transport.start(() => {
      readyCount += 1;
    });
    await waitFor(() => readyCount === 1, `${deviceId} 首次连接`);
    await waitFor(() => broker.subscribes.some((s) => s.topic === `helmet/${deviceId}/cmd`), `${deviceId} 订阅 cmd`);
    return { transport, logs, ready: () => readyCount };
  };

  const acksOf = (deviceId: string): Array<Record<string, unknown>> =>
    broker.publishesTo(`helmet/${deviceId}/cmd_ack`).map((p) => JSON.parse(p.payload) as Record<string, unknown>);

  it('未 start 就 send / stop：不抛异常，stop 照样回调（退出流程不能卡死）', async () => {
    const t = createMqttTransport({ url, deviceId: 'helmet_never', deviceSecret: 's', cmdResult: 'success', log: () => undefined });
    assert.doesNotThrow(() =>
      t.send('status', buildEnvelope('helmet_never', '1.0.0', 'device_status', { battery: 1 }) as EventEnvelope<EventType>),
    );
    await new Promise<void>((resolve) => t.stop(resolve));
    assert.equal(broker.connects.some((c) => c.clientId === 'helmet_never'), false);
  });

  it('认证身份与 Topic：clientId = username = deviceId、password = deviceSecret；只订阅自己的 cmd（QoS 1）；三类上行各走各的 Topic（QoS 1），内容原样', async () => {
    const id = 'helmet_topics';
    const { transport } = await connect(id);
    assert.deepEqual(
      broker.connects.filter((c) => c.clientId === id),
      [{ clientId: id, username: id, password: `secret_of_${id}` }],
    );
    assert.deepEqual(
      broker.subscribes.filter((s) => s.topic.includes(id)),
      [{ topic: `helmet/${id}/cmd`, qos: 1 }],
    );

    const status = buildEnvelope(id, '1.0.0', 'device_status', { battery: 0 });
    const location = buildEnvelope(id, '1.0.0', 'location_update', {
      latitude: -33.86,
      longitude: 151.21,
      coordinateSystem: 'wgs84',
      accuracy: 0,
      speed: 0,
      heading: 0,
    });
    const fall = buildEnvelope(id, '1.0.0', 'possible_fall', {});
    transport.send('status', status as EventEnvelope<EventType>);
    transport.send('location', location as EventEnvelope<EventType>);
    transport.send('event', fall as EventEnvelope<EventType>);
    await waitFor(() => broker.publishes.filter((p) => p.topic.startsWith(`helmet/${id}/`)).length === 3, '三条上行');

    for (const [kind, envelope] of [['status', status], ['location', location], ['event', fall]] as const) {
      const got = broker.publishesTo(`helmet/${id}/${kind}`);
      assert.equal(got.length, 1, kind);
      assert.equal(got[0].qos, 1, kind);
      // 0 / 空对象这类假值字段不能在序列化时丢掉
      assert.deepEqual(JSON.parse(got[0].payload), envelope, kind);
    }
  });

  it('命令回执三态并行验证：success 按清单逐键校验、failed 强制拒绝、silent 一条不回', async () => {
    const ok = await connect('helmet_cmd_ok', 'success');
    await connect('helmet_cmd_failed', 'failed');
    const silent = await connect('helmet_cmd_silent', 'silent');
    const cmd = (commandId: string, params: unknown, type = 'set_config'): string =>
      JSON.stringify({ commandId, type, params, issuedAt: new Date().toISOString() });

    const sentAt = Date.now();
    broker.publish('helmet/helmet_cmd_ok/cmd', cmd('c_valid_0001', { volume: 1, light: 3, buzzer: false }));
    broker.publish('helmet/helmet_cmd_ok/cmd', cmd('c_range_0001', { volume: 50, radarDistance: 31 }));
    broker.publish('helmet/helmet_cmd_ok/cmd', cmd('c_unknown_01', { beepVolume: 50 }));
    broker.publish('helmet/helmet_cmd_ok/cmd', cmd('c_empty_0001', {}));
    broker.publish('helmet/helmet_cmd_failed/cmd', cmd('c_forced_001', { volume: 50 }));
    broker.publish('helmet/helmet_cmd_silent/cmd', cmd('c_silent_001', { volume: 50 }));

    await waitFor(() => acksOf('helmet_cmd_ok').length === 4 && acksOf('helmet_cmd_failed').length === 1, '五条回执');
    assert.ok(Date.now() - sentAt >= 450, '回执前有模拟执行耗时（≈500ms），不是收到即回');

    const byId = new Map(acksOf('helmet_cmd_ok').map((a) => [a.commandId, a]));
    const valid = byId.get('c_valid_0001');
    assert.equal(valid?.result, 'success');
    assert.equal('errorCode' in (valid ?? {}), false, 'success 回执不带 errorCode');
    assert.match(String(valid?.executedAt), ISO_UTC);
    assert.equal(byId.get('c_range_0001')?.result, 'failed');
    assert.equal(byId.get('c_range_0001')?.errorCode, 'ERR_PARAM_VALUE:radarDistance');
    assert.equal(byId.get('c_unknown_01')?.errorCode, 'UNSUPPORTED_SETTING:beepVolume');
    assert.equal(byId.get('c_empty_0001')?.errorCode, 'EMPTY_PARAMS');
    assert.equal(broker.publishesTo('helmet/helmet_cmd_ok/cmd_ack').every((p) => p.qos === 1), true);

    assert.deepEqual(
      acksOf('helmet_cmd_failed').map((a) => [a.commandId, a.result, a.errorCode]),
      [['c_forced_001', 'failed', 'MOCK_REJECTED']],
    );

    // silent：别人的回执都到了它还没回，再多等一会儿仍然没有
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(acksOf('helmet_cmd_silent'), []);
    assert.ok(silent.logs.some((l) => l.includes('不回执')));
    assert.ok(ok.logs.some((l) => l.includes('已回执 success')));
  });

  it('畸形命令（非 JSON / JSON null / 缺 commandId）：记日志、不回执、不掉线，之后的正常命令照常执行', async () => {
    const id = 'helmet_cmd_bad';
    const { logs, ready } = await connect(id);
    broker.publish(`helmet/${id}/cmd`, 'not json');
    broker.publish(`helmet/${id}/cmd`, 'null');
    broker.publish(`helmet/${id}/cmd`, JSON.stringify({ type: 'set_config', params: { volume: 50 } }));
    await waitFor(() => logs.filter((l) => l.includes('无法解析的命令消息')).length === 3, '三条畸形命令被识别');

    broker.publish(`helmet/${id}/cmd`, JSON.stringify({ commandId: 'c_after_0001', type: 'set_config', params: { volume: 50 } }));
    await waitFor(() => acksOf(id).length === 1, '畸形命令后的正常回执');
    assert.deepEqual(
      acksOf(id).map((a) => [a.commandId, a.result]),
      [['c_after_0001', 'success']],
    );
    assert.equal(ready(), 1, '全程没有断线重连');
  });

  it('被踢下线后自动重连：每次都重新订阅 cmd 并再次 onReady；连续 3 次快速重连只告警一次「可能有同 ID 实例」', async () => {
    const id = 'helmet_kicked';
    const { logs, ready } = await connect(id);
    const subs = (): number => broker.subscribes.filter((s) => s.topic === `helmet/${id}/cmd`).length;
    const warned = (): number => logs.filter((l) => l.includes('连接被反复顶替')).length;

    for (let round = 1; round <= 3; round += 1) {
      assert.equal(warned(), 0, `第 ${round} 次被踢前还不该告警`);
      broker.kick();
      await waitFor(() => ready() === 1 + round && subs() === 1 + round, `第 ${round} 次重连`);
    }
    assert.equal(warned(), 1);

    // 第 4 次快速重连：计数继续涨，但不重复刷屏
    broker.kick();
    await waitFor(() => ready() === 5, '第 4 次重连');
    assert.equal(warned(), 1);
  });
});
