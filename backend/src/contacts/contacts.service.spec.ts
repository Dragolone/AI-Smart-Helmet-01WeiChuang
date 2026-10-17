// 紧急联系人（API.md §3）：上限 5（咨询锁串行化计数）、只改传了的字段、归属 + 未删校验、注销时批量软删。
import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { CONTACT_LIMIT, ContactsService } from './contacts.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  userId: 'u1',
  name: '妈',
  phone: '13800001111',
  relation: '母亲',
  createdAt: new Date('2026-10-16T00:00:00Z'),
  deletedAt: null,
  ...over,
});

describe('ContactsService', () => {
  const tx = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    emergencyContact: { count: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    emergencyContact: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const svc = new ContactsService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    tx.$executeRaw.mockResolvedValue(1);
    tx.$queryRaw.mockResolvedValue([{ deleted_at: null }]);
  });

  it('list：只列未删的，按创建时间正序，时间转 ISO', async () => {
    prisma.emergencyContact.findMany.mockResolvedValue([row()]);
    await expect(svc.list('u1')).resolves.toEqual([
      {
        id: 'c1',
        name: '妈',
        phone: '13800001111',
        relation: '母亲',
        createdAt: '2026-10-16T00:00:00.000Z',
      },
    ]);
    expect(prisma.emergencyContact.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  });

  describe('create', () => {
    it('未满：先拿用户级咨询锁再计数，然后创建', async () => {
      tx.emergencyContact.count.mockResolvedValue(CONTACT_LIMIT - 1);
      tx.emergencyContact.create.mockResolvedValue(row({ id: 'c5' }));
      await expect(
        svc.create('u1', { name: '妈', phone: '13800001111' }),
      ).resolves.toMatchObject({ id: 'c5' });
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      const lockArgs = tx.$executeRaw.mock.calls[0] as unknown[];
      expect(lockArgs.slice(1)).toEqual(['contacts:u1']);
      expect(tx.emergencyContact.count).toHaveBeenCalledWith({
        where: { userId: 'u1', deletedAt: null },
      });
      expect(tx.emergencyContact.create).toHaveBeenCalledWith({
        data: { userId: 'u1', name: '妈', phone: '13800001111' },
      });
    });

    it('拿到锁后发现账号已被注销：401，不计数不创建', async () => {
      tx.$queryRaw.mockResolvedValue([{ deleted_at: new Date() }]);
      const err = await svc
        .create('u1', { name: '妈', phone: '13800001111' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(tx.emergencyContact.count).not.toHaveBeenCalled();
      expect(tx.emergencyContact.create).not.toHaveBeenCalled();
    });

    it('已满 5 个：409 EMERGENCY_CONTACT_LIMIT_REACHED，不创建', async () => {
      tx.emergencyContact.count.mockResolvedValue(CONTACT_LIMIT);
      const err = await svc
        .create('u1', { name: 'x', phone: '13800002222' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual({
        code: 'EMERGENCY_CONTACT_LIMIT_REACHED',
        message: '紧急联系人最多 5 个',
      });
      expect(tx.emergencyContact.create).not.toHaveBeenCalled();
    });
  });

  describe('update / remove', () => {
    it('只改传了的字段（空串也算传了）', async () => {
      prisma.emergencyContact.findFirst.mockResolvedValue(row());
      prisma.emergencyContact.update.mockResolvedValue(row({ relation: '' }));
      await svc.update('u1', 'c1', { relation: '' });
      expect(prisma.emergencyContact.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { relation: '' },
      });
      await svc.update('u1', 'c1', { name: '妈妈', phone: '13800003333' });
      expect(prisma.emergencyContact.update).toHaveBeenLastCalledWith({
        where: { id: 'c1' },
        data: { name: '妈妈', phone: '13800003333' },
      });
    });

    it('他人的 / 已删的：404「联系人不存在」，不写库', async () => {
      prisma.emergencyContact.findFirst.mockResolvedValue(null);
      await expect(
        svc.update('u1', 'c9', { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.remove('u1', 'c9')).rejects.toMatchObject({
        response: { code: 'NOT_FOUND', message: '联系人不存在' },
      });
      expect(prisma.emergencyContact.findFirst).toHaveBeenCalledWith({
        where: { id: 'c9', userId: 'u1', deletedAt: null },
      });
      expect(prisma.emergencyContact.update).not.toHaveBeenCalled();
    });

    it('remove：软删（写 deletedAt）', async () => {
      prisma.emergencyContact.findFirst.mockResolvedValue(row());
      await svc.remove('u1', 'c1');
      expect(prisma.emergencyContact.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  describe('removeAll（注销账号用）', () => {
    it('默认用自身 Prisma；传了事务客户端就用事务客户端', async () => {
      await svc.removeAll('u1');
      expect(prisma.emergencyContact.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      const txUpdateMany = jest.fn();
      await svc.removeAll('u1', {
        emergencyContact: { updateMany: txUpdateMany },
      } as never);
      expect(txUpdateMany).toHaveBeenCalledTimes(1);
      expect(prisma.emergencyContact.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
