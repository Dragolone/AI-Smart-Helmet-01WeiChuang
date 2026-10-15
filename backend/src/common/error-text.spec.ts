import { errorMessage, errorStack } from './error-text';

describe('error-text', () => {
  it('errorMessage：Error 取 message，其余 String()', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('errorStack：有堆栈取堆栈；Error 没有堆栈时退回 message；非 Error 走 String()', () => {
    const e = new Error('with stack');
    expect(errorStack(e)).toBe(e.stack);
    const noStack = new Error('no stack');
    noStack.stack = undefined;
    expect(errorStack(noStack)).toBe('no stack');
    expect(errorStack({ toString: () => 'obj' })).toBe('obj');
  });
});
