// 控制器内定义（未导出）的请求 DTO：经 design:paramtypes 元数据取到类，再按 ValidationPipe 同样的
// plainToInstance + validate 走一遍，钉住 API.md 的入参口径（与全局 ValidationPipe({ whitelist, transform }) 一致）。
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CommandsController } from './commands/commands.controller';
import { ContactsController } from './contacts/contacts.controller';
import { DevicesController } from './devices/devices.controller';
import { EventsController } from './events/events.controller';
import { AppRelayController } from './ingest/app-relay.controller';
import { LocationsController } from './locations/locations.controller';
import { UsersController } from './users/users.controller';
import { VoiceController } from './voice/voice.controller';

type Ctor = new () => object;
/** 取控制器方法第 index 个参数的类型（即 @Body / @Query 的 DTO 类） */
const dtoOf = (
  ctl: { prototype: object },
  method: string,
  index: number,
): Ctor => {
  const types = Reflect.getMetadata(
    'design:paramtypes',
    ctl.prototype,
    method,
  ) as Ctor[];
  return types[index];
};
const run = (cls: Ctor, body: object) => {
  const inst = plainToInstance(cls, body) as Record<string, unknown>;
  const errors = validateSync(inst, { whitelist: true }).map((e) => e.property);
  return { inst, errors: errors.sort() };
};

describe('控制器内的请求 DTO', () => {
  describe('设备', () => {
    const Bind = dtoOf(DevicesController, 'bind', 1);
    const Rename = dtoOf(DevicesController, 'rename', 2);
    const Battery = dtoOf(DevicesController, 'batteryHistory', 2);

    it('绑定：deviceId 只允许安全字符集 1–64；绑定码 4–64', () => {
      expect(
        run(Bind, { deviceId: 'helmet_a1-B', bindCode: '1234' }).errors,
      ).toEqual([]);
      expect(
        run(Bind, { deviceId: "x' OR 1=1", bindCode: '123' }).errors,
      ).toEqual(['bindCode', 'deviceId']);
      expect(
        run(Bind, { deviceId: 'a'.repeat(65), bindCode: '1'.repeat(65) })
          .errors,
      ).toEqual(['bindCode', 'deviceId']);
    });

    it('重命名：name 选填、≤20 字', () => {
      expect(run(Rename, {}).errors).toEqual([]);
      expect(run(Rename, { name: '一'.repeat(20) }).errors).toEqual([]);
      expect(run(Rename, { name: '一'.repeat(21) }).errors).toEqual(['name']);
      expect(run(Rename, { name: 5 }).errors).toEqual(['name']);
    });

    it('电量历史：hours 缺省 24，字符串转整数，1–168', () => {
      expect(run(Battery, {}).inst.hours).toBe(24);
      expect(run(Battery, { hours: '168' })).toEqual({
        inst: expect.objectContaining({ hours: 168 }),
        errors: [],
      });
      expect(run(Battery, { hours: '0' }).errors).toEqual(['hours']);
      expect(run(Battery, { hours: '169' }).errors).toEqual(['hours']);
      expect(run(Battery, { hours: '1.5' }).errors).toEqual(['hours']);
    });
  });

  describe('紧急联系人', () => {
    const Create = dtoOf(ContactsController, 'create', 1);
    const Update = dtoOf(ContactsController, 'update', 2);

    it('新建：名字先 trim 再验（全空白不能入库，会原样进 SOS 短信）', () => {
      const ok = run(Create, { name: '  妈  ', phone: '13800001111' });
      expect(ok.errors).toEqual([]);
      expect(ok.inst.name).toBe('妈');
      expect(run(Create, { name: '   ', phone: '13800001111' }).errors).toEqual(
        ['name'],
      );
      expect(run(Create, { name: '妈', phone: '1380000111' }).errors).toEqual([
        'phone',
      ]);
      expect(
        run(Create, {
          name: '妈',
          phone: '13800001111',
          relation: 'r'.repeat(21),
        }).errors,
      ).toEqual(['relation']);
    });

    it('修改：没传可以跳过；传了 null 不放过（必填列写 null 会炸成 500）', () => {
      expect(run(Update, {}).errors).toEqual([]);
      expect(run(Update, { relation: '父亲' }).errors).toEqual([]);
      expect(run(Update, { name: null, phone: null }).errors).toEqual([
        'name',
        'phone',
      ]);
      expect(run(Update, { name: ' ' }).errors).toEqual(['name']);
    });
  });

  describe('我的', () => {
    const UpdateMe = dtoOf(UsersController, 'updateMe', 1);
    const DeleteMe = dtoOf(UsersController, 'deleteMe', 1);

    it.each([
      ['https://cdn.example.com/a.png', true],
      ['http://x/a', true],
      ['data:image/png;base64,iVBORw0KGgo=', true],
      ['data:image/webp;base64,AAAA', true],
      ['data:image/gif;base64,AAAA', false],
      ['data:text/html;base64,PHNjcmlwdD4=', false],
      ['javascript:alert(1)', false],
      ['https://has space/a.png', false],
    ])('头像 %p → %p', (avatarUrl, ok) => {
      expect(run(UpdateMe, { avatarUrl }).errors).toEqual(
        ok ? [] : ['avatarUrl'],
      );
    });

    it('昵称 ≤30；注销要 1–72 字符的密码', () => {
      expect(run(UpdateMe, { nickname: 'n'.repeat(31) }).errors).toEqual([
        'nickname',
      ]);
      expect(run(DeleteMe, { password: '' }).errors).toEqual(['password']);
      expect(run(DeleteMe, { password: 'p'.repeat(72) }).errors).toEqual([]);
      expect(run(DeleteMe, { password: 'p'.repeat(73) }).errors).toEqual([
        'password',
      ]);
    });
  });

  describe('命令 / 中转', () => {
    const Put = dtoOf(CommandsController, 'putSettings', 2);
    const RelayAck = dtoOf(CommandsController, 'relayAck', 3);
    const Relay = dtoOf(AppRelayController, 'relay', 1);

    it('下发设置：settings 必须是对象（键值合法性在服务层）', () => {
      expect(run(Put, { settings: { volume: 5 } }).errors).toEqual([]);
      expect(run(Put, { settings: [1] }).errors).toEqual(['settings']);
      expect(run(Put, {}).errors).toEqual(['settings']);
    });

    it('relay-ack：stage / result 枚举；errorCode、executedAt 选填字符串', () => {
      expect(
        run(RelayAck, { stage: 'executed', result: 'success' }).errors,
      ).toEqual([]);
      expect(run(RelayAck, { stage: 'done' }).errors).toEqual(['stage']);
      expect(
        run(RelayAck, { stage: 'executed', result: 'ok', errorCode: 1 }).errors,
      ).toEqual(['errorCode', 'result']);
    });

    it('app-relay：deviceId 安全字符集；envelopes 1–100 条（内容交给 Ingest，不在 DTO 校验）', () => {
      expect(
        run(Relay, { deviceId: 'helmet_001', envelopes: [{}, 'x', 1] }).errors,
      ).toEqual([]);
      expect(
        run(Relay, { deviceId: 'helmet_001', envelopes: [] }).errors,
      ).toEqual(['envelopes']);
      expect(
        run(Relay, {
          deviceId: 'helmet_001',
          envelopes: Array.from({ length: 101 }, () => ({})),
        }).errors,
      ).toEqual(['envelopes']);
      expect(run(Relay, { deviceId: 'a/b', envelopes: {} }).errors).toEqual([
        'deviceId',
        'envelopes',
      ]);
    });
  });

  describe('对讲', () => {
    const Create = dtoOf(VoiceController, 'create', 1);
    const Join = dtoOf(VoiceController, 'join', 1);

    it('邀请码：6 位字母或数字', () => {
      expect(run(Join, { inviteCode: 'aB3dE9' }).errors).toEqual([]);
      expect(run(Join, { inviteCode: 'ABC23' }).errors).toEqual(['inviteCode']);
      expect(run(Join, { inviteCode: 'ABC-23' }).errors).toEqual([
        'inviteCode',
      ]);
    });

    it('频道名整理后 1–30：全空白 / 只含零宽字符 400，与联系人同口径（BC3 已修）', () => {
      expect(run(Create, { name: '车队' }).errors).toEqual([]);
      expect(run(Create, { name: '' }).errors).toEqual(['name']);
      expect(run(Create, { name: 'n'.repeat(31) }).errors).toEqual(['name']);
      expect(run(Create, { name: '   ' }).errors).toEqual(['name']);
      expect(run(Create, { name: '\u200b\n' }).errors).toEqual(['name']);
      expect(run(Create, { name: ` ${'n'.repeat(30)} ` }).errors).toEqual([]);
    });
  });

  describe('查询参数', () => {
    const Track = dtoOf(LocationsController, 'track', 2);
    const Range = dtoOf(LocationsController, 'summary', 2);
    const Events = dtoOf(EventsController, 'list', 2);

    it('轨迹：from / to 必填 ISO；maxPoints 缺省 1000、2–2000', () => {
      const ok = run(Track, {
        from: '2026-10-16T00:00:00Z',
        to: '2026-10-16T01:00:00Z',
      });
      expect(ok.errors).toEqual([]);
      expect(ok.inst.maxPoints).toBe(1000);
      expect(
        run(Track, { from: 'x', to: '2026-10-16T01:00:00Z', maxPoints: '1' })
          .errors,
      ).toEqual(['from', 'maxPoints']);
      expect(run(Range, {}).errors).toEqual(['from', 'to']);
    });

    it('事件列表：type ≤300 字符，from / to 选填 ISO，分页默认', () => {
      const ok = run(Events, {});
      expect(ok.errors).toEqual([]);
      expect(ok.inst).toMatchObject({ page: 1, pageSize: 20 });
      expect(
        run(Events, { type: 't'.repeat(301), to: 'yesterday' }).errors,
      ).toEqual(['to', 'type']);
    });
  });
});
