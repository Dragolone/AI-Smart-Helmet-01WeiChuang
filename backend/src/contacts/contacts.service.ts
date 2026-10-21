import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EmergencyContact as WireContact } from '@helmet/shared';
import type { EmergencyContact, Prisma } from '../generated/prisma/client';
import { lockLiveUser } from '../common/live-user';
import { PrismaService } from '../prisma/prisma.service';

type DbClient = PrismaService | Prisma.TransactionClient;

/** 每用户活跃联系人上限（API.md §3 定稿）；软删除的不占名额 */
export const CONTACT_LIMIT = 5;

const notFound = () =>
  new NotFoundException({
    code: 'NOT_FOUND',
    message: '联系人不存在',
  });

/** 本人号码不能当紧急联系人：求救短信发给自己没有意义，还占一个名额（B 线 23；App 端已拦，接口原来没拦） */
const contactIsSelf = () =>
  new BadRequestException({
    code: 'CONTACT_IS_SELF',
    message: '紧急联系人不能填本人手机号',
  });

/** 同一号码不重复：占名额，求救时还要靠通知去重才不会发两条 */
const contactDuplicate = () =>
  new ConflictException({
    code: 'CONTACT_DUPLICATE',
    message: '这个号码已经是你的紧急联系人',
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
      await this.lockContacts(tx, userId);
      // 注销同时在进行时，不能给已注销账号留下一个第三方的姓名和手机号
      await lockLiveUser(tx, userId);
      await this.ensurePhoneAllowed(tx, userId, data.phone);
      const active = await tx.emergencyContact.count({
        where: { userId, deletedAt: null },
      });
      if (active >= CONTACT_LIMIT) {
        throw new ConflictException({
          code: 'EMERGENCY_CONTACT_LIMIT_REACHED',
          message: `紧急联系人最多 ${CONTACT_LIMIT} 个`,
          details: { limit: CONTACT_LIMIT },
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
    // 同一把用户级锁：改号码时的「本人 / 重复」检查与并发的新增串行
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.lockContacts(tx, userId);
      await this.getOwnedActive(userId, contactId, tx);
      if (data.phone !== undefined) {
        await this.ensurePhoneAllowed(tx, userId, data.phone, contactId);
      }
      return tx.emergencyContact.update({
        where: { id: contactId },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.phone !== undefined && { phone: data.phone }),
          ...(data.relation !== undefined && { relation: data.relation }),
        },
      });
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

  private async lockContacts(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contacts:${userId}`}))`;
  }

  /**
   * 号码不能是本人的、不能与本人另一个活跃联系人重复（改号码时不算自己这条）。
   * 已软删的不算重复：删掉再加回同一个人是正常操作
   */
  private async ensurePhoneAllowed(
    tx: Prisma.TransactionClient,
    userId: string,
    phone: string,
    exceptContactId?: string,
  ): Promise<void> {
    const me = await tx.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    if (me?.phone === phone) throw contactIsSelf();
    const duplicates = await tx.emergencyContact.count({
      where: {
        userId,
        deletedAt: null,
        phone,
        ...(exceptContactId && { id: { not: exceptContactId } }),
      },
    });
    if (duplicates > 0) throw contactDuplicate();
  }

  /** 归属 + 未删校验：他人的、已删的一律 404（不泄露存在性，与设备模块同口径） */
  private async getOwnedActive(
    userId: string,
    contactId: string,
    db: DbClient = this.prisma,
  ): Promise<EmergencyContact> {
    const contact = await db.emergencyContact.findFirst({
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
