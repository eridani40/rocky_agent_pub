/**
 * computer-native-port 单测 —— 主进程 port 实现（注入 fake systemPreferences + fake addon）
 * 参考: app/electron/src/computer-native-port.ts
 *       change_plan_v2_batch2 §P1-C（11 能力走 native addon；screenshot 改 native；addon 缺失 fail-closed）
 *
 * 守 memory test-no-real-spawn-system-gui：注入 fake addon（返 canned JSON 信封），不触真原生动作/GUI。
 * 平台条件：checkPermissions 的 computeGetPermissions 在非 darwin 短路降级；darwin 与 CI 各测对应分支。
 */
import { describe, it, expect } from 'vitest';
import { makeElectronComputerNativePort } from '../computer-native-port';
import type { AddonLike } from '../computer-native-addon';
import type { SystemPreferencesLike } from '../computer-permissions-ipc';

function fakeSys(over: Partial<{ ax: boolean; screen: string }> = {}): SystemPreferencesLike {
  return {
    isTrustedAccessibilityClient: () => over.ax ?? false,
    getMediaAccessStatus: () => over.screen ?? 'not-determined',
  };
}

/** fake addon：记录每次 invoke(method, paramsJson)，返 responder(method,params) 生成的信封 JSON 串 */
function fakeAddon(
  responder: (method: string, params: Record<string, unknown>) => Record<string, unknown>,
): { addon: AddonLike; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const addon: AddonLike = {
    ping: () => '{"ok":true,"pong":"pong"}',
    invoke: async (method, paramsJson) => {
      const params = JSON.parse(paramsJson) as Record<string, unknown>;
      calls.push({ method, params });
      return JSON.stringify(responder(method, params));
    },
  };
  return { addon, calls };
}

const okEnvelope = (result: unknown) => ({ ok: true, result });

describe('makeElectronComputerNativePort — checkPermissions（electron systemPreferences）', () => {
  it('spike 多态形状 → tool 门禁两态', async () => {
    const port = makeElectronComputerNativePort({
      systemPreferences: fakeSys({ ax: true, screen: 'granted' }),
      loadAddon: () => undefined,
    });
    const perms = await port.checkPermissions();
    if (process.platform === 'darwin') {
      expect(perms).toEqual({ accessibility: 'granted', screenRecording: 'granted' });
    } else {
      expect(perms).toEqual({ accessibility: 'missing', screenRecording: 'missing' });
    }
  });
});

describe('makeElectronComputerNativePort — 读类走 native addon', () => {
  it('screenshot：拼 {app} 参数 → 映射 native 截图 dict（裸 base64 + windowBounds）', async () => {
    const { addon, calls } = fakeAddon(() =>
      okEnvelope({
        mediaType: 'image/png',
        data: 'ZZ',
        width: 1280,
        height: 800,
        scaleFactor: 2,
        windowBounds: { x: 10, y: 20, w: 640, h: 400 },
      }),
    );
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    const shot = await port.screenshot({ app: 'com.apple.Safari' });
    expect(shot).toEqual({
      ok: true,
      mediaType: 'image/png',
      data: 'ZZ',
      width: 1280,
      height: 800,
      scaleFactor: 2,
      windowBounds: { x: 10, y: 20, w: 640, h: 400 },
    });
    expect(calls[0]).toEqual({ method: 'screenshot', params: { app: 'com.apple.Safari' } });
  });

  it('getAppState：截图 + AX 合一；嵌套 screenshot 补 ok:true', async () => {
    const { addon } = fakeAddon(() =>
      okEnvelope({
        screenshot: { mediaType: 'image/png', data: 'IMG', width: 100, height: 50 },
        axText: '[0] AXButton "OK"',
        pid: 1234,
        scaleFactor: 2,
        windowBounds: { x: 0, y: 0, w: 100, h: 50 },
      }),
    );
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    const state = await port.getAppState({ app: 'Safari', textLimit: 200 });
    expect(state.ok).toBe(true);
    expect(state.screenshot).toEqual({
      ok: true,
      mediaType: 'image/png',
      data: 'IMG',
      width: 100,
      height: 50,
      scaleFactor: undefined,
      windowBounds: undefined,
    });
    expect(state.axText).toBe('[0] AXButton "OK"');
    expect(state.pid).toBe(1234);
    expect(state.windowBounds).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  it('readAxTree：映射 {text,nodes,pid}', async () => {
    const { addon, calls } = fakeAddon(() =>
      okEnvelope({ text: '[0] AXWindow', nodes: [{ index: 0, role: 'AXWindow' }], pid: 42 }),
    );
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    const tree = await port.readAxTree({ maxNodes: 10 });
    expect(tree).toEqual({ ok: true, text: '[0] AXWindow', nodes: [{ index: 0, role: 'AXWindow' }], pid: 42, scaleFactor: undefined });
    expect(calls[0]?.params).toEqual({ maxNodes: 10 });
  });

  it('listApps：解包数组结果', async () => {
    const apps = [{ bundleId: 'com.apple.Safari', name: 'Safari', pid: 501, isRunning: true }];
    const { addon } = fakeAddon(() => okEnvelope(apps));
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    expect(await port.listApps()).toEqual(apps);
  });
});

describe('makeElectronComputerNativePort — 动作类走 native addon', () => {
  it('click：拼 {target,button,clickCount} → {ok:true}', async () => {
    const { addon, calls } = fakeAddon(() => okEnvelope({ ok: true }));
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    const r = await port.click({ elementIndex: 3 }, { button: 'right', clickCount: 2, app: 'Finder' });
    expect(r).toEqual({ ok: true });
    expect(calls[0]).toEqual({
      method: 'click',
      params: { target: { elementIndex: 3 }, button: 'right', clickCount: 2, app: 'Finder' },
    });
  });

  it('drag：拼 {from,to,steps}', async () => {
    const { addon, calls } = fakeAddon(() => okEnvelope({ ok: true }));
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    await port.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, { steps: 5 });
    expect(calls[0]?.params).toEqual({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, steps: 5 });
  });

  it('setValue / performSecondaryAction：拼必填参数', async () => {
    const { addon, calls } = fakeAddon(() => okEnvelope({ ok: true }));
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    await port.setValue(2, 'hello', { app: 'TextEdit' });
    await port.performSecondaryAction(2, 'AXRaise');
    expect(calls[0]).toEqual({ method: 'setValue', params: { elementIndex: 2, value: 'hello', app: 'TextEdit' } });
    expect(calls[1]).toEqual({ method: 'performSecondaryAction', params: { elementIndex: 2, action: 'AXRaise' } });
  });
});

describe('makeElectronComputerNativePort — fail-closed', () => {
  it('addon 缺失：读类返 {ok:false,reason} / listApps 返空数组 / 动作类 {ok:false}', async () => {
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => undefined });
    expect((await port.screenshot()).ok).toBe(false);
    expect((await port.getAppState()).ok).toBe(false);
    expect((await port.readAxTree()).ok).toBe(false);
    expect(await port.listApps()).toEqual([]);
    expect((await port.click({ elementIndex: 0 })).ok).toBe(false);
  });

  it('native 错误信封 → {ok:false, reason=error.message}', async () => {
    const { addon } = fakeAddon(() => ({ ok: false, error: { code: 'element_not_found', message: 'no element 9' } }));
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    const r = await port.setValue(9, 'x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no element 9');
  });

  it('v0.0.160：native state_unavailable → code 透传给 handler（供友好文案分支）', async () => {
    const { addon } = fakeAddon(() => ({
      ok: false,
      error: { code: 'state_unavailable', message: 'type_text requires a focused editable text element.' },
    }));
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    const r = await port.type('hello');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('state_unavailable');
    expect(r.reason).toContain('focused editable');
  });

  it('v0.0.160：native 无 code 分类（仅 message）→ code 为 undefined，reason 有值', async () => {
    const { addon } = fakeAddon(() => ({ ok: false, error: { message: 'unclassified' } }));
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    const r = await port.click({ elementIndex: 0 });
    expect(r.ok).toBe(false);
    expect(r.code).toBeUndefined();
    expect(r.reason).toContain('unclassified');
  });

  it('v0.0.160：AX 采集 textLimit="max" 原样透传 native params（Swift SnapshotTextLimit.parse 消费）', async () => {
    const { addon, calls } = fakeAddon(() =>
      okEnvelope({ text: 'BIG TREE', pid: 1, scaleFactor: 1 }),
    );
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    await port.readAxTree({ textLimit: 'max' });
    expect(calls[0]?.params).toEqual({ textLimit: 'max' });
  });

  it('invoke 抛 → {ok:false, reason}', async () => {
    const addon: AddonLike = {
      ping: () => '{}',
      invoke: async () => {
        throw new Error('boom');
      },
    };
    const port = makeElectronComputerNativePort({ systemPreferences: fakeSys(), loadAddon: () => addon });
    const r = await port.screenshot();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('boom');
  });
});
