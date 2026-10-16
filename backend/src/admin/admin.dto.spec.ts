// 管理后台查询 DTO：分页默认值与上限（PageQueryDto）、布尔开关只收 'true' / 'false'、状态枚举、时间参数。
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  AdminAccidentsQueryDto,
  AdminDevicesQueryDto,
  AdminEventsQueryDto,
  AdminLoginDto,
  AdminUsersQueryDto,
} from './admin.dto';

const check = <T extends object>(cls: new () => T, q: object) => {
  const inst = plainToInstance(cls, q);
  return { inst, errors: validateSync(inst).map((e) => e.property) };
};

describe('admin DTO 校验', () => {
  it('分页：缺省 page=1 / pageSize=20；字符串转数字；pageSize 上限 100、page 至少 1', () => {
    const d = check(AdminUsersQueryDto, {});
    expect(d.errors).toEqual([]);
    expect(d.inst).toMatchObject({ page: 1, pageSize: 20 });
    expect(
      check(AdminUsersQueryDto, { page: '3', pageSize: '100' }).inst,
    ).toMatchObject({
      page: 3,
      pageSize: 100,
    });
    expect(check(AdminUsersQueryDto, { pageSize: '101' }).errors).toEqual([
      'pageSize',
    ]);
    expect(check(AdminUsersQueryDto, { page: '0' }).errors).toEqual(['page']);
    expect(check(AdminUsersQueryDto, { page: '1.5' }).errors).toEqual(['page']);
  });

  it("布尔开关只收 'true' / 'false' 字符串", () => {
    expect(
      check(AdminUsersQueryDto, { includeDeleted: 'true' }).errors,
    ).toEqual([]);
    expect(check(AdminUsersQueryDto, { includeDeleted: '1' }).errors).toEqual([
      'includeDeleted',
    ]);
    expect(check(AdminDevicesQueryDto, { online: 'false' }).errors).toEqual([]);
    expect(check(AdminDevicesQueryDto, { online: 'yes' }).errors).toEqual([
      'online',
    ]);
    expect(check(AdminEventsQueryDto, { invalid: 'TRUE' }).errors).toEqual([
      'invalid',
    ]);
  });

  it('事故状态枚举；关键词 ≤64 字', () => {
    expect(
      check(AdminAccidentsQueryDto, { status: 'notified' }).errors,
    ).toEqual([]);
    expect(check(AdminAccidentsQueryDto, { status: 'done' }).errors).toEqual([
      'status',
    ]);
    expect(
      check(AdminDevicesQueryDto, { keyword: 'k'.repeat(65) }).errors,
    ).toEqual(['keyword']);
  });

  it('事件查询的时间参数必须是可解析的 ISO 8601', () => {
    expect(
      check(AdminEventsQueryDto, {
        from: '2026-10-16T00:00:00Z',
        to: '2026-10-17',
      }).errors,
    ).toEqual([]);
    expect(check(AdminEventsQueryDto, { from: '2026-W42' }).errors).toEqual([
      'from',
    ]);
  });

  it('登录：用户名 1–64、密码 1–128', () => {
    expect(
      check(AdminLoginDto, { username: 'ops', password: 'p' }).errors,
    ).toEqual([]);
    expect(
      check(AdminLoginDto, { username: '', password: '' }).errors.sort(),
    ).toEqual(['password', 'username']);
    expect(
      check(AdminLoginDto, {
        username: 'u'.repeat(65),
        password: 'p'.repeat(129),
      }).errors.sort(),
    ).toEqual(['password', 'username']);
  });
});
