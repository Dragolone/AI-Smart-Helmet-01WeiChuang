import type { CommandPublic } from '@helmet/shared';
import type { DeviceCommand } from '../generated/prisma/client';

export function toWireCommand(c: DeviceCommand): CommandPublic {
  return {
    commandId: c.id,
    deviceId: c.deviceId,
    type: c.type,
    params: c.params as Record<string, unknown>,
    status: c.status as CommandPublic['status'],
    issuedAt: c.issuedAt.toISOString(),
    deliveredAt: c.deliveredAt ? c.deliveredAt.toISOString() : null,
    ackResult: c.ackResult as CommandPublic['ackResult'],
    errorCode: c.errorCode,
    executedAt: c.executedAt ? c.executedAt.toISOString() : null,
  };
}
