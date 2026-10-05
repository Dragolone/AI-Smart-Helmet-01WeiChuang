import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeCommand, executeSetConfig } from './settings-exec.ts';

describe('settings-exec（头盔侧参数校验的软件版）', () => {
  it('清单内合法值 → success', () => {
    assert.deepEqual(executeSetConfig({ volume: 70, light: 2, buzzer: true }), { result: 'success' });
  });

  it('越界 / 类型不符 → ERR_PARAM_VALUE:<key>，指明是哪一项', () => {
    assert.deepEqual(executeSetConfig({ volume: 101 }), { result: 'failed', errorCode: 'ERR_PARAM_VALUE:volume' });
    assert.deepEqual(executeSetConfig({ buzzer: 1 }), { result: 'failed', errorCode: 'ERR_PARAM_VALUE:buzzer' });
  });

  it('未知键 → UNSUPPORTED_SETTING:<key>；多键时第一个不合法的键决定回执', () => {
    assert.deepEqual(executeSetConfig({ beepVolume: 50 }), { result: 'failed', errorCode: 'UNSUPPORTED_SETTING:beepVolume' });
    assert.deepEqual(executeSetConfig({ volume: 50, radarDistance: 99, light: 9 }), {
      result: 'failed',
      errorCode: 'ERR_PARAM_VALUE:radarDistance',
    });
  });

  it('空对象 / 非对象 → 失败而不是静默成功', () => {
    assert.equal(executeSetConfig({}).result, 'failed');
    assert.equal(executeSetConfig(null).result, 'failed');
    assert.equal(executeSetConfig('x').result, 'failed');
  });
});

describe('executeCommand（按命令类型分派）', () => {
  it('set_config → 走逐键校验，结果与 executeSetConfig 一致', () => {
    assert.deepEqual(executeCommand('set_config', { volume: 70 }), { result: 'success' });
    assert.deepEqual(executeCommand('set_config', { volume: 101 }), {
      result: 'failed',
      errorCode: 'ERR_PARAM_VALUE:volume',
    });
  });

  it('头盔不认识的命令类型 → failed ERR_INSTRUCTION：没执行过的命令不能回执成功', () => {
    for (const type of ['reboot', 'ota_start', 'SET_CONFIG', '', 'set_config ']) {
      assert.deepEqual(executeCommand(type, { volume: 70 }), { result: 'failed', errorCode: 'ERR_INSTRUCTION' }, type);
    }
  });
});
