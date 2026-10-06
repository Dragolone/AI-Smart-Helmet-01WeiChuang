import { retrying } from './retry';

describe('retrying', () => {
  it('首次成功：只调一次，不等待', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retrying(fn, 2, 0)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('失败两次后第三次成功：共调 3 次，onRetry 收到两次（第 1、2 次重试）', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue('ok');
    const onRetry = jest.fn();
    await expect(retrying(fn, 2, 0, onRetry)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map((c) => c[1] as number)).toEqual([1, 2]);
  });

  it('一直失败：用完重试次数后抛最后一次的错', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('last'));
    await expect(retrying(fn, 2, 0)).rejects.toThrow('last');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries=0：只试一次', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('x'));
    await expect(retrying(fn, 0, 0)).rejects.toThrow('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
