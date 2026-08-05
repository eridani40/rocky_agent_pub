/**
 * native-port-registry 单测 —— process 级 setX/getX 注入 seam
 * 参考: app/server/src/platform/computer/native-port-registry.ts
 *       change_plan_v2 §2 注入链路 / §5 P0-A
 */
import { describe, it, expect, afterEach } from 'vitest';
import { setComputerNativePort, getComputerNativePort } from '../native-port-registry';
import type { ComputerNativePort } from '../native-port';

const fakePort: ComputerNativePort = {
  checkPermissions: async () => ({ accessibility: 'granted', screenRecording: 'granted' }),
  screenshot: async () => ({ ok: true, mediaType: 'image/png', data: 'AAAA' }),
  getAppState: async () => ({ ok: true, axText: '', scaleFactor: 2 }),
  readAxTree: async () => ({ ok: true, text: '', scaleFactor: 2 }),
  listApps: async () => [],
  click: async () => ({ ok: true }),
  type: async () => ({ ok: true }),
  scroll: async () => ({ ok: true }),
  pressKey: async () => ({ ok: true }),
  drag: async () => ({ ok: true }),
  setValue: async () => ({ ok: true }),
  performSecondaryAction: async () => ({ ok: true }),
};

describe('native-port-registry', () => {
  afterEach(() => setComputerNativePort(undefined)); // 模块单例，测试间清理

  it('未注入 → getComputerNativePort 返 undefined', () => {
    setComputerNativePort(undefined);
    expect(getComputerNativePort()).toBeUndefined();
  });

  it('setX 注入 → getX 取回同一实例', () => {
    setComputerNativePort(fakePort);
    expect(getComputerNativePort()).toBe(fakePort);
  });

  it('set undefined 可清除（测试隔离）', () => {
    setComputerNativePort(fakePort);
    setComputerNativePort(undefined);
    expect(getComputerNativePort()).toBeUndefined();
  });
});
