// 传输层抽象：剧本（index.ts）只管"发生了什么事件"，由传输层决定"怎么送到后端"。
// 两种实现对应两种产品形态的真机链路（DEVICE_PROTOCOL §1）：
//   mqtt      —— 4G 链路：头盔直连 EMQX（决策 #6，代码已就绪等硬件扩展 4G）
//   app-relay —— MVP 唯一真机链路：头盔 BLE → 手机 App 中转 → HTTPS（决策 #31/#35）
// 事件内容（envelope）两者完全一致——Contract 不因链路而变。
import type { EventEnvelope, EventType } from '@helmet/shared';

export type EventKind = 'status' | 'location' | 'event';

export interface Transport {
  /** 传输就绪后调用 onReady 启动剧本；剧本不关心连接细节 */
  start(onReady: () => void): void;
  send(kind: EventKind, envelope: EventEnvelope<EventType>): void;
  stop(done: () => void): void;
}

export type Log = (msg: string) => void;

/** 命令回执行为（MOCK_CMD_RESULT）：两条链路同三态——silent 不回执，演示服务端超时判 offline */
export type CmdResult = 'success' | 'failed' | 'silent';
