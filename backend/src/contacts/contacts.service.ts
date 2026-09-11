import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EmergencyContact as WireContact } from '@helmet/shared';
import type { EmergencyContact, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type DbClient = PrismaService | Prisma.TransactionClient;

/** 每用户活跃联系人上限（API.md §3 定稿）；软删除的不占名额 */
export const CONTACT_LIMIT = 5;

const notFound = () =>
  new NotFoundException({
    code: 'NOT_FOUND',
    message: '联系人不存在',
  });

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<WireContact[]> {
    const contacts = await this.prisma.emergencyContact.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return contacts.map(toWire);
  }

  async create(
    userId: string,
    data: { name: string; phone: string; relation?: string },
  ): Promise<WireContact> {
    // 事务级咨询锁按用户串行化「计数 → 创建」：并发创建不会突破名额（先查后写的经典竞态）
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contacts:${userId}`}))`;
      const active = await tx.emergencyContact.count({
        where: { userId, deletedAt: null },
      });
      if (active >= CONTACT_LIMIT) {
        throw new ConflictException({
          code: 'EMERGENCY_CONTACT_LIMIT_REACHED',
          message: `紧急联系人最多 ${CONTACT_LIMIT} 个`,
        });
      }
      return tx.emergencyContact.create({ data: { userId, ...data } });
    });
    return toWire(created);
  }

  async update(
    userId: string,
    contactId: string,
    data: { name?: string; phone?: string; relation?: string },
  ): Promise<WireContact> {
    await this.getOwnedActive(userId, contactId);
    const updated = await this.prisma.emergencyContact.update({
      where: { id: contactId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.relation !== undefined && { relation: data.relation }),
      },
    });
    return toWire(updated);
  }

  async remove(userId: string, contactId: string): Promise<void> {
    await this.getOwnedActive(userId, contactId);
    await this.prisma.emergencyContact.update({
      where: { id: contactId },
      data: { deletedAt: new Date() },
    });
  }

  /** 软删除该用户全部活跃联系人（注销账号用）；历史 SOS 通知记录留档不受影响 */
  async removeAll(userId: string, db: DbClient = this.prisma): Promise<void> {
    await db.emergencyContact.updateMany({
      where: { userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  /** 归属 + 未删校验：他人的、已删的一律 404（不泄露存在性，与设备模块同口径） */
  private async getOwnedActive(
    userId: string,
    contactId: string,
  ): Promise<EmergencyContact> {
    const contact = await this.prisma.emergencyContact.findFirst({
      where: { id: contactId, userId, deletedAt: null },
    });
    if (!contact) throw notFound();
    return contact;
  }
}

function toWire(c: EmergencyContact): WireContact {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    relation: c.relation,
    createdAt: c.createdAt.toISOString(),
  };
}
