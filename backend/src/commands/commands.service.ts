import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  CommandPublic,
  CommandStatus,
  DeviceCommand as WireCommand,
  Paginated,
  RelayAckRequest,
  RelayAckResponse,
  SettingsResponse,
  WsDeviceCommandData,
  WsMessage,
} from '@helmet/shared';
import { Prisma } from '../generated/prisma/client';
import type { DeviceCommand as DbCommand } from '../generated/prisma/client';
import { MqttConsumerService } from '../ingest/mqtt-consumer.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  COMMAND_STATUS,
  SETTINGS_KEY_MAX_LENGTH,
  SETTINGS_MAX_KEYS,
  SETTINGS_STRING_MAX_LENGTH,
} from './commands.constants';
import { toWireCommand } from './command-wire';

const deviceNotFound = () =>
  new NotFoundException({
    code: 'DEVICE_NOT_FOUND',
    message: '设备不存在或未绑定到当前用户',
  });

const validationFailed = (message: string) =>
  new BadRequestException({ code: 'VALIDATION_FAILED', message });

/** 设置参数护栏（清单待硬件 ⚠️）：扁平对象、标量值、数量/长度上限；结构性脏数据在入口挡住 */
export function validateSettingsParams(
  params: unknown,
): Record<string, string | number | boolean> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw validationFailed('settings 必须是对象');
  }
  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.length === 0) throw validationFailed('settings 不能为空');
  if (entries.length > SETTINGS_MAX_KEYS) {
    throw validationFailed(`settings 最多 ${SETTINGS_MAX_KEYS} 个键`);
  }
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (key.length > SETTINGS_KEY_MAX_LENGTH) {
      throw validationFailed(`键名过长：${key.slice(0, 20)}…`);
    }
    const t = typeof value;
    if (t === 'string') {
      if ((value as string).length > SETTINGS_STRING_MAX_LENGTH) {
        throw validationFailed(`键 ${key} 的字符串值过长`);
      }
      clean[key] = value as string;
    } else if (t === 'number' && Number.isFinite(value)) {
      clean[key] = value as number;
    } else if (t === 'boolean') {
      clean[key] = value as boolean;
    } else {
      throw validationFailed(
        `键 ${key} 的值必须是字符串/数字/布尔（不允许嵌套）`,
      );
    }
  }
  return clean;
}

/** cmd_ack 消息体校验（EVENTS.md §6）：设备输入不可信 */
function parseAck(raw: string): {
  commandId: string;
  result: 'success' | 'failed';
  errorCode: string | null;
  executedAt: Date;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.commandId !== 'string' || p.commandId.length === 0) return null;
  if (p.result !== 'success' && p.result !== 'failed') return null;
  const executedAt =
    typeof p.executedAt === 'string' ? new Date(p.executedAt) : new Date(NaN);
  return {
    commandId: p.commandId,
    result: p.result,
    errorCode: typeof p.errorCode === 'string' ? p.errorCode : null,
    // 设备时钟不可信：非法时间戳以服务器时间兜底（与 receivedAt 同哲学）
    executedAt: Number.isNaN(executedAt.getTime()) ? new Date() : executedAt,
  };
}

@Injectable()
export class CommandsService implements OnModuleInit {
  private readonly logger = new Logger(CommandsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttConsumerService,
    private readonly gateway: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    // 回调注入（避免 Ingest ↔ Commands 模块环）：cmd_ack 消息路由到本服务
    this.mqtt.setCmdAckHandler((deviceId, raw) =>
      this.handleAck(deviceId, raw),
    );
    // 连接补推（决策 #36 / API.md §11）：App 连上 WS 时把绑定设备的 pending/delivered 命令推一遍。
    // 含 delivered 的原因：delivered=PUBACK 只证明送达 Broker（#27④），蓝牙版设备不在 MQTT 上
    // PUBACK 照样成功——只推 pending 会让蓝牙版 App 永远收不到已 PUBACK 的命令。
    // offline 不补推（用户可能已重发），REST 兜底可查。
    this.gateway.setUserConnectedHandler(async (userId, client) => {
      // DeviceCommand 无到 Device 的外键关系（留档原则），两步查询
      const devices = await this.prisma.device.findMany({
        where: { bindUserId: userId },
        select: { deviceId: true },
      });
      if (devices.length === 0) return;
      const commands = await this.prisma.deviceCommand.findMany({
        where: {
          deviceId: { in: devices.map((d) => d.deviceId) },
          status: { in: [COMMAND_STATUS.pending, COMMAND_STATUS.delivered] },
        },
        orderBy: { issuedAt: 'asc' },
      });
      for (const c of commands) {
        this.gateway.sendToClient(client, this.toWsMessage(c));
      }
    });
  }

  /** WS device_command 消息组装（新命令实时推与连接补推共用同一格式） */
  private toWsMessage(c: DbCommand): WsMessage<WsDeviceCommandData> {
    return {
      type: 'device_command',
      data: {
        deviceId: c.deviceId,
        commandId: c.id,
        type: c.type as WireCommand['type'],
        params: c.params as Record<string, unknown>,
        issuedAt: c.issuedAt.toISOString(),
      },
      sentAt: new Date().toISOString(),
    };
  }

  /**
   * 下发设置（§8）：创建命令（pending）→ MQTT QoS1 发布 → PUBACK 后标 delivered。
   * 响应始终返回创建时的 pending 快照（Contract 口径）；发布失败留 pending，
   * 由扫描任务超时判 offline——设备离线绝不显示成功。
   */
  async putSettings(
    userId: string,
    deviceId: string,
    rawParams: unknown,
  ): Promise<{ commandId: string; status: 'pending' }> {
    await this.ensureDeviceOwned(userId, deviceId);
    const params = validateSettingsParams(rawParams);

    const command = await this.prisma.deviceCommand.create({
      data: {
        deviceId,
        type: 'set_config',
        params: params,
        issuedBy: userId,
      },
    });

    const wire: WireCommand = {
      commandId: command.id,
      type: 'set_config',
      params,
      issuedAt: command.issuedAt.toISOString(),
    };
    // 双路下发（决策 #36）：MQTT（4G 链路）+ WS 推绑定用户（BLE 链路）。
    // 业务不感知设备形态；WS 先发——pushToUser 是同步扇出，避免等 PUBACK 徒增 BLE 路径时延
    this.gateway.pushToUser(userId, this.toWsMessage(command));
    try {
      await this.mqtt.publishCommand(deviceId, JSON.stringify(wire));
      // PUBACK = 送达 Broker（口径 #27④）；条件更新防迟到——回执可能已先到并终态化
      await this.prisma.deviceCommand.updateMany({
        where: { id: command.id, status: COMMAND_STATUS.pending },
        data: { status: COMMAND_STATUS.delivered, deliveredAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `命令发布失败（留 pending，超时后判 offline）${command.id}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { commandId: command.id, status: 'pending' };
  }

  /**
   * BLE 下行链回执（决策 #36 / API.md §8 relay-ack）：App 替头盔提交。
   * delivered = App 已写入头盔（蓝牙版的"送达"）；executed = 头盔执行结果。
   * 幂等不报错：已终态再收都返回当前状态——App 补传无需关心先后。
   */
  async relayAck(
    userId: string,
    deviceId: string,
    commandId: string,
    ack: RelayAckRequest,
  ): Promise<RelayAckResponse> {
    await this.ensureDeviceOwned(userId, deviceId);
    const command = await this.prisma.deviceCommand.findUnique({
      where: { id: commandId },
    });
    if (!command || command.deviceId !== deviceId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: '命令不存在' });
    }

    if (ack.stage === 'delivered') {
      // 与 PUBACK 同语义同防护：只从 pending 前进；已 delivered/终态则幂等返回现状
      await this.prisma.deviceCommand.updateMany({
        where: { id: commandId, status: COMMAND_STATUS.pending },
        data: { status: COMMAND_STATUS.delivered, deliveredAt: new Date() },
      });
    } else {
      const executedAt =
        ack.executedAt !== undefined ? new Date(ack.executedAt) : new Date();
      await this.applyAck(command, {
        result: ack.result,
        errorCode: ack.errorCode ?? null,
        // App 转发的头盔时间戳同样不可信：非法值以服务器时间兜底
        executedAt: Number.isNaN(executedAt.getTime())
          ? new Date()
          : executedAt,
      });
    }
    const updated = await this.prisma.deviceCommand.findUniqueOrThrow({
      where: { id: commandId },
      select: { status: true },
    });
    return { commandId, status: updated.status as CommandStatus };
  }

  /** 回执处理（MQTT cmd_ack）：终态化 + success 时才把参数合入设备当前生效设置（口径 #27③） */
  async handleAck(deviceId: string, raw: string): Promise<void> {
    const ack = parseAck(raw);
    if (!ack) {
      this.logger.warn(`cmd_ack 消息体不合法，忽略（device=${deviceId}）`);
      return;
    }
    const command = await this.prisma.deviceCommand.findUnique({
      where: { id: ack.commandId },
    });
    if (!command || command.deviceId !== deviceId) {
      // deviceId 不匹配 = 越权/串线回执，拒绝处理
      this.logger.warn(
        `cmd_ack 找不到匹配命令或设备不符，忽略：${ack.commandId}（device=${deviceId}）`,
      );
      return;
    }
    await this.applyAck(command, ack);
  }

  /**
   * 回执终态化核心（MQTT cmd_ack 与 relay-ack 两条路径共用，决策 #36）：
   * 条件更新防竞态；迟到回执如实覆盖 offline；只有 success 才写入生效设置。
   */
  private async applyAck(
    command: DbCommand,
    ack: {
      result: 'success' | 'failed';
      errorCode: string | null;
      executedAt: Date;
    },
  ): Promise<void> {
    if (
      command.status === COMMAND_STATUS.success ||
      command.status === COMMAND_STATUS.failed
    ) {
      this.logger.debug(`重复回执已跳过：${command.id}`);
      return;
    }
    if (command.status === COMMAND_STATUS.offline) {
      // 迟到回执：设备实际执行了，如实覆盖 offline（DEVICE_PROTOCOL §7 语义）
      this.logger.warn(
        `迟到回执（已判 offline）如实覆盖：${command.id} → ${ack.result}`,
      );
    }

    const nextStatus =
      ack.result === 'success' ? COMMAND_STATUS.success : COMMAND_STATUS.failed;
    await this.prisma.$transaction(async (tx) => {
      // 条件更新：不与另一份回执/扫描竞态双写
      const won = await tx.deviceCommand.updateMany({
        where: {
          id: command.id,
          status: {
            in: [
              COMMAND_STATUS.pending,
              COMMAND_STATUS.delivered,
              COMMAND_STATUS.offline,
            ],
          },
        },
        data: {
          status: nextStatus,
          ackResult: ack.result,
          errorCode: ack.errorCode,
          executedAt: ack.executedAt,
          ackedAt: new Date(),
        },
      });
      if (won.count === 0) return;

      // 只有 success 才写入当前生效设置——未执行/失败绝不显示成功（CLAUDE.md 铁律）
      if (
        nextStatus === COMMAND_STATUS.success &&
        command.type === 'set_config'
      ) {
        // 迟到回执不能把更新的命令已生效的键覆盖回旧值：剔除比本命令更晚下发且已 success 的命令触碰过的键
        const newer = await tx.deviceCommand.findMany({
          where: {
            deviceId: command.deviceId,
            type: 'set_config',
            status: COMMAND_STATUS.success,
            issuedAt: { gt: command.issuedAt },
            id: { not: command.id },
          },
          select: { params: true },
        });
        const shadowed = new Set(
          newer.flatMap((c) =>
            Object.keys(c.params as Record<string, unknown>),
          ),
        );
        const applicable = Object.fromEntries(
          Object.entries(command.params as Record<string, unknown>).filter(
            ([k]) => !shadowed.has(k),
          ),
        );
        if (shadowed.size > 0) {
          this.logger.warn(
            `迟到回执 ${command.id}：键 ${[...shadowed].join(',')} 已被更新命令覆盖，不回写`,
          );
        }
        const device = await tx.device.findUnique({
          where: { deviceId: command.deviceId },
          select: { settings: true },
        });
        const merged = {
          ...((device?.settings as Record<string, unknown> | null) ?? {}),
          ...applicable,
        };
        await tx.device.update({
          where: { deviceId: command.deviceId },
          data: { settings: merged as Prisma.InputJsonValue },
        });
      }
    });
    this.logger.log(
      `命令回执已处理：${command.id} → ${nextStatus}${ack.errorCode ? `（${ack.errorCode}）` : ''}`,
    );
  }

  /** 当前生效设置 + 最近一次下发状态（§8） */
  async getSettings(
    userId: string,
    deviceId: string,
  ): Promise<SettingsResponse> {
    await this.ensureDeviceOwned(userId, deviceId);
    const [device, lastCommand] = await this.prisma.$transaction([
      this.prisma.device.findUniqueOrThrow({
        where: { deviceId },
        select: { settings: true },
      }),
      this.prisma.deviceCommand.findFirst({
        where: { deviceId },
        orderBy: { issuedAt: 'desc' },
      }),
    ]);
    return {
      settings: (device.settings as Record<string, unknown> | null) ?? {},
      lastCommand: lastCommand ? toWireCommand(lastCommand) : null,
    };
  }

  async listCommands(
    userId: string,
    deviceId: string,
    page: number,
    pageSize: number,
  ): Promise<Paginated<CommandPublic>> {
    await this.ensureDeviceOwned(userId, deviceId);
    const where = { deviceId };
    const [total, commands] = await this.prisma.$transaction([
      this.prisma.deviceCommand.count({ where }),
      this.prisma.deviceCommand.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: commands.map(toWireCommand), total, page, pageSize };
  }

  /** 命令详情：归属 = 命令所属设备的当前绑定用户 */
  async getCommand(userId: string, commandId: string): Promise<CommandPublic> {
    const command = await this.prisma.deviceCommand.findUnique({
      where: { id: commandId },
    });
    if (command) {
      const device = await this.prisma.device.findUnique({
        where: { deviceId: command.deviceId },
        select: { bindUserId: true },
      });
      if (device?.bindUserId === userId) return toWireCommand(command);
    }
    throw new NotFoundException({ code: 'NOT_FOUND', message: '命令不存在' });
  }

  private async ensureDeviceOwned(
    userId: string,
    deviceId: string,
  ): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
      select: { bindUserId: true },
    });
    if (!device || device.bindUserId !== userId) throw deviceNotFound();
  }
}
