import { Injectable, Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { ContactsService } from '../contacts/contacts.service';
import { DevicesService } from '../devices/devices.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly devices: DevicesService,
    private readonly contacts: ContactsService,
  ) {}

  /**
   * 注销账号（API.md §2，App Store 要求应用内可注销）：软删除留档，一个事务内完成——
   * 置 deletedAt、phone 改写为 deleted:<id>（释放号码供再注册，原号不保留）、清头像、
   * 撤销全部会话、解绑全部设备（与 DELETE /devices/{id}/binding 同口径）、软删全部紧急联系人。
   * 事故/事件/轨迹等历史数据按设备留档不动。
   */
  async deleteAccount(userId: string, password: string): Promise<void> {
    await this.auth.verifyPassword(userId, password);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: now, phone: `deleted:${userId}`, avatarUrl: null },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.devices.unbindAll(userId, tx);
      await this.contacts.removeAll(userId, tx);
    });
    this.logger.log(`用户 ${userId} 已注销：会话撤销、设备解绑、联系人删除`);
  }
}
