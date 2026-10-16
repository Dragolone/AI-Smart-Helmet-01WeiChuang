// 其余控制器只做「登录态 userId + 路径 / 查询参数 → 服务层」的转交：钉住参数顺序与少量转换
//（admin 的 'true'/'false' 转布尔、设备重命名缺省 null、位置类接口先做归属校验再查）。
import { NotFoundException } from '@nestjs/common';
import { AdminAuthController } from './admin/admin-auth.controller';
import { AdminController } from './admin/admin.controller';
import { AuthController } from './auth/auth.controller';
import type { AuthenticatedRequest } from './auth/jwt-auth.guard';
import { ContactsController } from './contacts/contacts.controller';
import { DevicesController } from './devices/devices.controller';
import { EmqxHookController } from './emqx/emqx-hook.controller';
import { EventsController } from './events/events.controller';
import {
  LocationsController,
  RidesController,
} from './locations/locations.controller';
import { MediaController } from './media/media.controller';
import { SosController } from './sos/sos.controller';
import { VoiceController } from './voice/voice.controller';

const req = { user: { userId: 'u1' } } as AuthenticatedRequest;
const mockOf = <T extends string>(...names: T[]) =>
  Object.fromEntries(names.map((n) => [n, jest.fn()])) as Record<T, jest.Mock>;
const as = <T>(m: object) => m as unknown as T;

describe('控制器参数转交', () => {
  it('AuthController：各接口参数顺序与服务层签名一致', async () => {
    const s = mockOf(
      'sendSmsCode',
      'register',
      'login',
      'resetPassword',
      'changePassword',
      'changePhone',
      'refresh',
      'logout',
    );
    const c = new AuthController(as(s));
    await c.smsCode({ phone: 'p', purpose: 'register' });
    void c.register({ phone: 'p', code: '1', password: 'pw', nickname: 'n' });
    void c.login({ phone: 'p', password: 'pw' });
    await c.resetPassword({ phone: 'p', code: '1', newPassword: 'np' });
    await c.changePassword(req, {
      oldPassword: 'o',
      newPassword: 'n',
      refreshToken: 'rt',
    });
    void c.changePhone(req, { password: 'pw', newPhone: 'np', code: 'c' });
    void c.refresh({ refreshToken: 'rt' });
    await c.logout({ refreshToken: 'rt' });
    expect(s.sendSmsCode).toHaveBeenCalledWith('p', 'register');
    expect(s.register).toHaveBeenCalledWith('p', '1', 'pw', 'n');
    expect(s.login).toHaveBeenCalledWith('p', 'pw');
    expect(s.resetPassword).toHaveBeenCalledWith('p', '1', 'np');
    expect(s.changePassword).toHaveBeenCalledWith('u1', 'o', 'n', 'rt');
    expect(s.changePhone).toHaveBeenCalledWith('u1', 'np', 'c', 'pw');
    expect(s.refresh).toHaveBeenCalledWith('rt');
    expect(s.logout).toHaveBeenCalledWith('rt');
  });

  it('AdminController：布尔开关字符串转布尔；online 不传时保持 undefined（不筛）', () => {
    const s = mockOf(
      'listUsers',
      'listDevices',
      'listAccidents',
      'getDeviceDetail',
      'statsOverview',
      'listEvents',
    );
    const c = new AdminController(as(s));
    void c.users({
      page: 1,
      pageSize: 20,
      keyword: 'k',
      includeDeleted: 'true',
    });
    void c.users({ page: 1, pageSize: 20 });
    void c.devices({ page: 2, pageSize: 5, online: 'false' });
    void c.devices({ page: 2, pageSize: 5 });
    void c.accidents({
      page: 1,
      pageSize: 20,
      status: 'pending',
      deviceId: 'h',
    });
    void c.deviceDetail('h');
    void c.statsOverview();
    void c.events({
      page: 1,
      pageSize: 20,
      type: 't',
      deviceId: 'h',
      from: 'f',
      to: 't2',
      invalid: 'true',
    });
    void c.events({ page: 1, pageSize: 20 });
    expect(s.listUsers.mock.calls).toEqual([
      [1, 20, 'k', true],
      [1, 20, undefined, false],
    ]);
    expect(s.listDevices.mock.calls).toEqual([
      [2, 5, undefined, false],
      [2, 5, undefined, undefined],
    ]);
    expect(s.listAccidents).toHaveBeenCalledWith(1, 20, 'pending', 'h');
    expect(s.getDeviceDetail).toHaveBeenCalledWith('h');
    expect(s.statsOverview).toHaveBeenCalled();
    expect(s.listEvents.mock.calls).toEqual([
      [1, 20, { type: 't', deviceId: 'h', from: 'f', to: 't2', invalid: true }],
      [
        1,
        20,
        {
          type: undefined,
          deviceId: undefined,
          from: undefined,
          to: undefined,
          invalid: false,
        },
      ],
    ]);
  });

  it('AdminAuthController / MediaController / EmqxHookController', async () => {
    const auth = mockOf('login');
    void new AdminAuthController(as(auth)).login({
      username: 'ops',
      password: 'pw',
    });
    expect(auth.login).toHaveBeenCalledWith('ops', 'pw');

    const media = mockOf('getUrl');
    void new MediaController(as(media)).getUrl(req, 'm1');
    expect(media.getUrl).toHaveBeenCalledWith('u1', 'm1');

    const hook = mockOf('authenticate', 'authorize');
    const emqx = new EmqxHookController(as(hook));
    await emqx.authenticate({ clientid: 'c', username: 'u', password: 'p' });
    void emqx.authorize({
      clientid: 'c',
      username: 'u',
      topic: 't',
      action: 'publish',
    });
    expect(hook.authenticate).toHaveBeenCalledWith('u', 'p', 'c');
    expect(hook.authorize).toHaveBeenCalledWith('u', 't', 'publish');
  });

  it('DevicesController：重命名没传 name 不改（只查一遍返回现状，B7）、null 是清除；其余直传', async () => {
    const s = mockOf(
      'bind',
      'listMine',
      'getOwned',
      'rename',
      'status',
      'batteryHistory',
      'unbind',
    );
    const c = new DevicesController(as(s));
    void c.bind(req, { deviceId: 'h', bindCode: '1' });
    void c.list(req);
    void c.detail(req, 'h');
    void c.rename(req, 'h', {});
    void c.rename(req, 'h', { name: null });
    void c.rename(req, 'h', { name: '新' });
    void c.status(req, 'h');
    void c.batteryHistory(req, 'h', { hours: 6 });
    await c.unbind(req, 'h');
    expect(s.bind).toHaveBeenCalledWith('u1', 'h', '1');
    expect(s.listMine).toHaveBeenCalledWith('u1');
    expect(s.getOwned.mock.calls).toEqual([
      ['u1', 'h'],
      ['u1', 'h'],
    ]);
    expect(s.rename.mock.calls).toEqual([
      ['u1', 'h', null],
      ['u1', 'h', '新'],
    ]);
    expect(s.status).toHaveBeenCalledWith('u1', 'h');
    expect(s.batteryHistory).toHaveBeenCalledWith('u1', 'h', 6);
    expect(s.unbind).toHaveBeenCalledWith('u1', 'h');
  });

  it('ContactsController / SosController / VoiceController / EventsController', async () => {
    const contacts = mockOf('list', 'create', 'update', 'remove');
    const cc = new ContactsController(as(contacts));
    void cc.list(req);
    void cc.create(req, { name: 'n', phone: 'p' });
    void cc.update(req, 'c1', { relation: 'r' });
    await cc.remove(req, 'c1');
    expect(contacts.create).toHaveBeenCalledWith('u1', {
      name: 'n',
      phone: 'p',
    });
    expect(contacts.update).toHaveBeenCalledWith('u1', 'c1', { relation: 'r' });
    expect(contacts.remove).toHaveBeenCalledWith('u1', 'c1');

    const sos = mockOf(
      'active',
      'activeForUser',
      'accidents',
      'accidentDetail',
      'cancel',
      'confirm',
    );
    const sc = new SosController(as(sos));
    void sc.active(req, 'h');
    void sc.activeForUser(req, { page: 2, pageSize: 100 });
    void sc.accidents(req, 'h', { page: 3, pageSize: 7 });
    void sc.accidentDetail(req, 'a1');
    void sc.cancel(req, 's1');
    void sc.confirm(req, 's1');
    expect(sos.activeForUser).toHaveBeenCalledWith('u1', 2, 100);
    expect(sos.accidents).toHaveBeenCalledWith('u1', 'h', 3, 7);
    expect(sos.accidentDetail).toHaveBeenCalledWith('u1', 'a1');
    expect(sos.cancel).toHaveBeenCalledWith('u1', 's1');
    expect(sos.confirm).toHaveBeenCalledWith('u1', 's1');

    const voice = mockOf(
      'create',
      'listMine',
      'join',
      'leave',
      'members',
      'token',
    );
    const vc = new VoiceController(as(voice));
    void vc.create(req, { name: '车队' });
    void vc.list(req);
    void vc.join(req, { inviteCode: 'ABC234' });
    await vc.leave(req, 'ch1');
    void vc.members(req, 'ch1');
    void vc.token(req, 'ch1');
    expect(voice.create).toHaveBeenCalledWith('u1', '车队');
    expect(voice.join).toHaveBeenCalledWith('u1', 'ABC234');
    expect(voice.leave).toHaveBeenCalledWith('u1', 'ch1');
    expect(voice.token).toHaveBeenCalledWith('u1', 'ch1');

    const events = mockOf('list', 'detail');
    const ec = new EventsController(as(events));
    const q = { page: 1, pageSize: 20, type: 'manual_sos' };
    void ec.list(req, 'h', q);
    void ec.detail(req, 'e1');
    expect(events.list).toHaveBeenCalledWith('u1', 'h', q);
    expect(events.detail).toHaveBeenCalledWith('u1', 'e1');
  });

  describe('位置 / 行程控制器：先做设备归属校验，非本人直接 404、不查位置', () => {
    const devices = mockOf('getOwned');
    const locations = mockOf(
      'latest',
      'summaryRange',
      'track',
      'listRange',
      'rides',
    );
    const lc = new LocationsController(as(devices), as(locations));
    const rc = new RidesController(as(devices), as(locations));
    beforeEach(() => {
      jest.clearAllMocks();
      devices.getOwned.mockResolvedValue({});
    });

    it('归属通过：参数原样转交', async () => {
      const range = { from: 'f', to: 't' };
      await lc.latest(req, 'h');
      await lc.summary(req, 'h', range);
      await lc.track(req, 'h', { ...range, maxPoints: 500 });
      await lc.list(req, 'h', { ...range, page: 2, pageSize: 50 });
      await rc.list(req, 'h', range);
      expect(devices.getOwned).toHaveBeenCalledTimes(5);
      expect(locations.latest).toHaveBeenCalledWith('u1', 'h');
      expect(locations.summaryRange).toHaveBeenCalledWith('u1', 'h', 'f', 't');
      expect(locations.track).toHaveBeenCalledWith('u1', 'h', 'f', 't', 500);
      expect(locations.listRange).toHaveBeenCalledWith(
        'u1',
        'h',
        'f',
        't',
        2,
        50,
      );
      expect(locations.rides).toHaveBeenCalledWith('u1', 'h', 'f', 't');
    });

    it('归属失败：抛 404，位置服务一次都不调', async () => {
      devices.getOwned.mockRejectedValue(new NotFoundException());
      await expect(lc.latest(req, 'h')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        lc.summary(req, 'h', { from: 'f', to: 't' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        rc.list(req, 'h', { from: 'f', to: 't' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      for (const fn of Object.values(locations))
        expect(fn).not.toHaveBeenCalled();
    });
  });
});
