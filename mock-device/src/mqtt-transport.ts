// MQTT 传输（4G 链路，DEVICE_PROTOCOL §2–§7）：头盔直连 EMQX。
// 含命令下行订阅与回执（§7）——这是 4G 链路独有的双向能力，app-relay 链路暂无对应通道。
import { connect, type MqttClient } from 'mqtt';
import type { EventEnvelope, EventType } from '@helmet/shared';
import type { EventKind, Log, Transport } from './transport.ts';

export type CmdResult = 'success' | 'failed' | 'silent';

export function createMqttTransport(cfg: {
  url: string;
  deviceId: string;
  deviceSecret: string;
  cmdResult: CmdResult;
  log: Log;
}): Transport {
  const { url, deviceId, deviceSecret, cmdResult, log } = cfg;
  let client: MqttClient | null = null;
  let lastConnectAt = 0;
  let rapidReconnects = 0;

  return {
    start(onReady) {
      client = connect(url, {
        clientId: deviceId,
        username: deviceId,
        password: deviceSecret,
      });

      client.on('connect', () => {
        // MQTT 同 clientId 互踢是真机语义：若被反复踢线，多半是又启动了一个同 deviceId 的实例
        const now = Date.now();
        rapidReconnects = now - lastConnectAt < 5000 ? rapidReconnects + 1 : 0;
        lastConnectAt = now;
        if (rapidReconnects === 3) {
          log(
            `⚠️ 连接被反复顶替——可能有另一个 ${deviceId} 实例在运行（MQTT 同 clientId 互踢）。请只保留一个实例，或用 DEVICE_ID 环境变量区分。`,
          );
        }
        log(`已连接 ${url}`);
        client?.subscribe(`helmet/${deviceId}/cmd`, { qos: 1 }, (err) => {
          if (err) log(`订阅 cmd 失败: ${err.message}`);
        });
        onReady();
      });

      // —— 命令接收与回执（DEVICE_PROTOCOL §7）：真机行为的软件版 ——
      client.on('message', (topic, payload) => {
        if (!topic.endsWith('/cmd')) return;
        try {
          const cmd = JSON.parse(payload.toString('utf-8')) as {
            commandId: string;
            type: string;
            params: Record<string, unknown>;
          };
          log(
            `收到命令 ${cmd.type}（${cmd.commandId.slice(0, 8)}…）params=${JSON.stringify(cmd.params)}`,
          );
          if (cmdResult === 'silent') {
            log('（MOCK_CMD_RESULT=silent：不回执，服务端将超时判 offline）');
            return;
          }
          const ack = {
            commandId: cmd.commandId,
            result: cmdResult,
            ...(cmdResult === 'failed' ? { errorCode: 'MOCK_REJECTED' } : {}),
            executedAt: new Date().toISOString(),
          };
          // 模拟设备执行耗时后回执
          setTimeout(() => {
            client?.publish(
              `helmet/${deviceId}/cmd_ack`,
              JSON.stringify(ack),
              { qos: 1 },
              (err) => {
                if (err) log(`回执发送失败: ${err.message}`);
                else log(`已回执 ${cmdResult}（${cmd.commandId.slice(0, 8)}…）`);
              },
            );
          }, 500);
        } catch {
          log('收到无法解析的命令消息，忽略');
        }
      });

      client.on('reconnect', () => log('重连中…'));
      client.on('error', (err) => log(`MQTT 错误: ${err.message}`));
    },

    send(kind: EventKind, envelope: EventEnvelope<EventType>) {
      client?.publish(
        `helmet/${deviceId}/${kind}`,
        JSON.stringify(envelope),
        { qos: 1 },
        (err) => {
          if (err) log(`发送失败 ${envelope.eventType}: ${err.message}`);
          else
            log(
              `已发送 ${envelope.eventType} (eventId=${envelope.eventId.slice(0, 8)}…)`,
            );
        },
      );
    },

    stop(done) {
      if (!client) return done();
      client.end(false, {}, done);
    },
  };
}
