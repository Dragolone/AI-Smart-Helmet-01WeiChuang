// Admin JWT 密钥（API.md §10）：未设拒绝启动；与用户 JWT 密钥相同只告警不抛（守卫两侧另有 typ 双保险）。
import { Logger } from '@nestjs/common';
import { adminJwtSecretProvider } from './admin.constants';

describe('adminJwtSecretProvider', () => {
  const saved = {
    admin: process.env.ADMIN_JWT_SECRET,
    user: process.env.JWT_SECRET,
  };
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.JWT_SECRET;
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const [k, v] of [
      ['ADMIN_JWT_SECRET', saved.admin],
      ['JWT_SECRET', saved.user],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('未设置：拒绝启动，提示看 .env.example', () => {
    expect(() => adminJwtSecretProvider.useFactory()).toThrow(
      /ADMIN_JWT_SECRET 未设置/,
    );
  });

  it('与 JWT_SECRET 相同：照常返回，但记 error 让运维一眼看到', () => {
    process.env.ADMIN_JWT_SECRET = 'same';
    process.env.JWT_SECRET = 'same';
    expect(adminJwtSecretProvider.useFactory()).toBe('same');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('ADMIN_JWT_SECRET 与 JWT_SECRET 相同'),
    );
  });

  it('不同：返回且不告警', () => {
    process.env.ADMIN_JWT_SECRET = 'admin-secret';
    process.env.JWT_SECRET = 'user-secret';
    expect(adminJwtSecretProvider.useFactory()).toBe('admin-secret');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
