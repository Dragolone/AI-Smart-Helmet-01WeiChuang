// 注销账号（API.md §2）：先验密码；同一事务里软删、释放号码、清验证码、撤会话、解绑设备、删联系人、退频道；事务后断开 WS。
import { Logger } from '@nestjs/common';
import type { AuthService } from '../auth/auth.service';
import type { ContactsService } from '../contacts/contacts.service';
import type { DevicesService } from '../devices/devices.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import { UsersService } from './users.service';

describe('UsersService.deleteAccount', () => {
  const order: string[] = [];
  const track =
    (name: string, value: unknown = undefined) =>
    () => {
      order.push(name);
      return Promise.resolve(value);
    };
  const tx = {
    user: {
      findUniqueOrThrow: jest.fn(track('user.find', { phone: '13800001111' })),
      update: jest.fn(track('user.update')),
    },
    smsCode: { deleteMany: jest.fn(track('smsCode.deleteMany')) },
    refreshToken: { updateMany: jest.fn(track('refreshToken.revoke')) },
    voiceChannelMember: { deleteMany: jest.fn(track('voice.leave')) },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => {
      order.push('tx.begin');
      await fn(tx);
      order.push('tx.commit');
    }),
  };
  const auth = { verifyPassword: jest.fn() };
  const devices = { unbindAll: jest.fn(track('devices.unbindAll')) };
  const contacts = { removeAll: jest.fn(track('contacts.removeAll')) };
  const realtime = {
    closeUser: jest.fn(() => {
      order.push('ws.close');
      return 2;
    }),
  };
  const svc = new UsersService(
    prisma as unknown as PrismaService,
    auth as unknown as AuthService,
    devices as unknown as DevicesService,
    contacts as unknown as ContactsService,
    realtime as unknown as RealtimeGateway,
  );
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    order.length = 0;
    jest.clearAllMocks();
    auth.verifyPassword.mockResolvedValue(undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => logSpy.mockRestore());

  it('密码不对：直接抛出，不开事务、不断连接', async () => {
    auth.verifyPassword.mockRejectedValue(new Error('PASSWORD_INCORRECT'));
    await expect(svc.deleteAccount('u1', 'bad')).rejects.toThrow(
      'PASSWORD_INCORRECT',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(realtime.closeUser).not.toHaveBeenCalled();
  });

  it('成功：事务内按序做完全部清理，事务提交后才断开 WS', async () => {
    await svc.deleteAccount('u1', 'pw');
    expect(order).toEqual([
      'tx.begin',
      'user.find',
      'user.update',
      'smsCode.deleteMany',
      'refreshToken.revoke',
      'devices.unbindAll',
      'contacts.removeAll',
      'voice.leave',
      'tx.commit',
      'ws.close',
    ]);
    const now = (
      tx.user.update.mock.calls[0] as unknown as [{ data: { deletedAt: Date } }]
    )[0].data.deletedAt;
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { deletedAt: now, phone: 'deleted:u1', avatarUrl: null },
    });
    // 原号码的验证码记录（明文手机号）一起删
    expect(tx.smsCode.deleteMany).toHaveBeenCalledWith({
      where: { phone: '13800001111' },
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null },
      data: { revokedAt: now },
    });
    // 解绑 / 删联系人走同一个事务客户端
    expect(devices.unbindAll).toHaveBeenCalledWith('u1', tx);
    expect(contacts.removeAll).toHaveBeenCalledWith('u1', tx);
    expect(tx.voiceChannelMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
    expect(realtime.closeUser).toHaveBeenCalledWith('u1', 4401, '账号已注销');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('断开 2 个实时连接'),
    );
  });

  it('事务中途失败（如解绑出错）：整体抛出，不断开 WS（注销没生效）', async () => {
    devices.unbindAll.mockImplementationOnce(() =>
      Promise.reject(new Error('unbind failed')),
    );
    await expect(svc.deleteAccount('u1', 'pw')).rejects.toThrow(
      'unbind failed',
    );
    expect(realtime.closeUser).not.toHaveBeenCalled();
    expect(contacts.removeAll).not.toHaveBeenCalled();
  });
});
