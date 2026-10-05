import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

/** 不存在与无权访问同一响应，不泄露设备存在性（API.md §4） */
export const deviceNotFound = (): NotFoundException =>
  new NotFoundException({
    code: 'DEVICE_NOT_FOUND',
    message: '设备不存在或未绑定到当前用户',
  });

/** 设备归属校验（§4/§5/§6/§7/§8/§12.1 同口径）：只有当前绑定用户可访问 */
export async function ensureDeviceOwned(
  prisma: Pick<PrismaService, 'device'>,
  userId: string,
  deviceId: string,
): Promise<void> {
  const device = await prisma.device.findUnique({
    where: { deviceId },
    select: { bindUserId: true },
  });
  if (!device || device.bindUserId !== userId) throw deviceNotFound();
}
