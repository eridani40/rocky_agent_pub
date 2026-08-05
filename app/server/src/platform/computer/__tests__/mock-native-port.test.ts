/**
 * MockComputerNativePort 单测 —— call-time fixture 读（缺口1）+ 归一化 + 文件加载器
 * 参考: app/server/src/platform/computer/mock-native-port.ts
 *       change_plan_v2 §5 P0-C/P0-F；memory test-no-real-spawn-system-gui
 *
 * 核心守护：**每次调用 fresh 读 fixture**（非构造缓存）——两 AT case 共享 booted env 写不同
 * fixture（granted vs missing），缓存会定死先 boot 的那个。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MockComputerNativePort,
  resolveMockComputerNativePort,
  fileFixtureLoader,
  type ComputerMockFixture,
} from '../mock-native-port';

/** 可变 fixture holder（模拟 case custom.sh 中途改文件） */
function mutableLoader(init: ComputerMockFixture): {
  loader: () => ComputerMockFixture;
  set: (f: ComputerMockFixture) => void;
} {
  let cur = init;
  return { loader: () => cur, set: (f) => (cur = f) };
}

describe('MockComputerNativePort（注入 loader）', () => {
  it('无 fixture → 默认两 granted + 默认 PNG（开箱可用）', async () => {
    const p = new MockComputerNativePort(() => ({}));
    expect(await p.checkPermissions()).toEqual({ accessibility: 'granted', screenRecording: 'granted' });
    const s = await p.screenshot();
    expect(s.ok).toBe(true);
    expect(s.mediaType).toBe('image/png');
    expect(typeof s.data).toBe('string');
    expect((s.data ?? '').length).toBeGreaterThan(0);
  });

  it('fixture 驱动 permissions（screenRecording=missing）', async () => {
    const p = new MockComputerNativePort(() => ({
      permissions: { accessibility: 'granted', screenRecording: 'missing' },
    }));
    expect(await p.checkPermissions()).toEqual({ accessibility: 'granted', screenRecording: 'missing' });
  });

  it('fixture 驱动 screenshot（base64/mediaType/width/height/scaleFactor/windowBounds 精确透传）', async () => {
    const p = new MockComputerNativePort(() => ({
      screenshotBase64: 'ZZZZ',
      mediaType: 'image/png',
      width: 3,
      height: 4,
      screenshotScaleFactor: 3,
      screenshotWindowBounds: { x: 1, y: 2, w: 3, h: 4 },
    }));
    expect(await p.screenshot()).toEqual({
      ok: true,
      mediaType: 'image/png',
      data: 'ZZZZ',
      width: 3,
      height: 4,
      scaleFactor: 3,
      windowBounds: { x: 1, y: 2, w: 3, h: 4 },
    });
  });

  it('screenshot 缺 windowBounds/scaleFactor → 默认 scaleFactor:2 + 1×1 windowBounds', async () => {
    const p = new MockComputerNativePort(() => ({ screenshotBase64: 'X', width: 1, height: 1 }));
    const s = await p.screenshot();
    expect(s.scaleFactor).toBe(2);
    expect(s.windowBounds).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('缺口1：call-time fresh 读 fixture（中途改 → 权限撤销，非构造缓存）', async () => {
    const m = mutableLoader({ permissions: { accessibility: 'granted', screenRecording: 'granted' } });
    const p = new MockComputerNativePort(m.loader);
    expect((await p.checkPermissions()).screenRecording).toBe('granted');
    m.set({ permissions: { accessibility: 'granted', screenRecording: 'missing' } });
    expect((await p.checkPermissions()).screenRecording).toBe('missing'); // 每次重读
  });

  it('权限值归一化（非 granted → missing，两态闭合）', async () => {
    const p = new MockComputerNativePort(() => ({
      permissions: { accessibility: 'denied', screenRecording: 'weird-value' },
    }));
    expect(await p.checkPermissions()).toEqual({ accessibility: 'missing', screenRecording: 'missing' });
  });
});

describe('MockComputerNativePort — readAxTree（第二批）', () => {
  it('无 axTree fixture → 默认小树 + scaleFactor:2 + pid:1234', async () => {
    const p = new MockComputerNativePort(() => ({}));
    const r = await p.readAxTree();
    expect(r.ok).toBe(true);
    expect(typeof r.text).toBe('string');
    expect((r.text ?? '').length).toBeGreaterThan(0);
    expect(r.scaleFactor).toBe(2);
    expect(r.pid).toBe(1234);
    expect((r.nodes ?? []).length).toBeGreaterThan(0);
  });

  it('fixture 驱动 axTree（text/nodes/pid/scaleFactor 精确透传）', async () => {
    const p = new MockComputerNativePort(() => ({
      axTree: { text: 'MYTREE', nodes: [{ index: 0, role: 'AXButton' }], pid: 42, scaleFactor: 1 },
    }));
    const r = await p.readAxTree();
    expect(r).toEqual({ ok: true, text: 'MYTREE', nodes: [{ index: 0, role: 'AXButton' }], pid: 42, scaleFactor: 1 });
  });

  it('axTree.ok===false → {ok:false,reason}（测 tool !ok 分支）', async () => {
    const p = new MockComputerNativePort(() => ({ axTree: { ok: false, reason: 'ax boom' } }));
    expect(await p.readAxTree()).toEqual({ ok: false, reason: 'ax boom' });
  });
});

describe('MockComputerNativePort — getAppState/listApps（第二批读类）', () => {
  it('无 appState fixture → 默认图+树 + scaleFactor:2 + windowBounds + pid:1234', async () => {
    const p = new MockComputerNativePort(() => ({}));
    const r = await p.getAppState();
    expect(r.ok).toBe(true);
    expect(r.screenshot?.data?.length).toBeGreaterThan(0);
    expect(typeof r.axText).toBe('string');
    expect((r.axText ?? '').length).toBeGreaterThan(0);
    expect(r.scaleFactor).toBe(2);
    expect(r.pid).toBe(1234);
    expect(r.windowBounds).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('fixture 驱动 appState（screenshot/axText/pid/scaleFactor/windowBounds 透传）', async () => {
    const p = new MockComputerNativePort(() => ({
      appState: {
        screenshot: { data: 'GG', mediaType: 'image/png', width: 20, height: 10, windowBounds: { x: 1, y: 2, w: 20, h: 10 } },
        axText: 'MYTREE', pid: 42, scaleFactor: 1, windowBounds: { x: 1, y: 2, w: 20, h: 10 },
      },
    }));
    const r = await p.getAppState();
    expect(r.screenshot?.data).toBe('GG');
    expect(r.screenshot?.windowBounds).toEqual({ x: 1, y: 2, w: 20, h: 10 });
    expect(r.axText).toBe('MYTREE');
    expect(r.pid).toBe(42);
    expect(r.scaleFactor).toBe(1);
    expect(r.windowBounds).toEqual({ x: 1, y: 2, w: 20, h: 10 });
  });

  it('appState.ok===false → {ok:false,reason}（测 tool !ok 分支）', async () => {
    const p = new MockComputerNativePort(() => ({ appState: { ok: false, reason: 'no app' } }));
    expect(await p.getAppState()).toEqual({ ok: false, reason: 'no app' });
  });

  it('无 apps fixture → 默认 1 app（Safari）', async () => {
    const p = new MockComputerNativePort(() => ({}));
    const apps = await p.listApps();
    expect(apps).toHaveLength(1);
    expect(apps[0]?.name).toBe('Safari');
  });

  it('fixture 驱动 apps（精确透传）', async () => {
    const apps = [{ bundleId: 'com.foo', name: 'Foo', pid: 7, isRunning: true }];
    const p = new MockComputerNativePort(() => ({ apps }));
    expect(await p.listApps()).toEqual(apps);
  });
});

describe('MockComputerNativePort — 动作类（第二批 actionResults：7 动作）', () => {
  it('无 actionResults → 全部 {ok:true}（忽略 target/opts）', async () => {
    const p = new MockComputerNativePort(() => ({}));
    expect(await p.click({ elementIndex: 1 })).toEqual({ ok: true });
    expect(await p.type('hi')).toEqual({ ok: true });
    expect(await p.scroll({ elementIndex: 1 }, { direction: 'down' })).toEqual({ ok: true });
    expect(await p.pressKey('cmd+s')).toEqual({ ok: true });
    expect(await p.drag({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ ok: true });
    expect(await p.setValue(1, 'v')).toEqual({ ok: true });
    expect(await p.performSecondaryAction(1, 'Raise')).toEqual({ ok: true });
  });

  it('fixture 驱动 drag/setValue/performSecondaryAction 失败分支', async () => {
    const p = new MockComputerNativePort(() => ({
      actionResults: {
        drag: { ok: false, reason: 'drag boom' },
        setValue: { ok: false, reason: 'not settable' },
        performSecondaryAction: { ok: false, reason: 'invalid action' },
      },
    }));
    expect(await p.drag({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ ok: false, reason: 'drag boom' });
    expect(await p.setValue(1, 'v')).toEqual({ ok: false, reason: 'not settable' });
    expect(await p.performSecondaryAction(1, 'X')).toEqual({ ok: false, reason: 'invalid action' });
  });

  it('fixture.actionResults.click.ok=false → {ok:false,reason}', async () => {
    const p = new MockComputerNativePort(() => ({ actionResults: { click: { ok: false, reason: 'no target' } } }));
    expect(await p.click({ elementIndex: 1 })).toEqual({ ok: false, reason: 'no target' });
    // 其余 action 未注入 → 仍默认成功
    expect(await p.type('x')).toEqual({ ok: true });
  });

  it('actionResults 各 action 独立驱动（scroll fail 不影响 pressKey）', async () => {
    const p = new MockComputerNativePort(() => ({
      actionResults: { scroll: { ok: false, reason: 'scroll boom' }, pressKey: { ok: true } },
    }));
    expect((await p.scroll({ elementIndex: 1 }, { direction: 'up' })).ok).toBe(false);
    expect((await p.pressKey('enter')).ok).toBe(true);
  });

  it('call-time fresh 读 fixture（中途改 actionResults 立即生效）', async () => {
    let cur: ComputerMockFixture = { actionResults: { click: { ok: true } } };
    const p = new MockComputerNativePort(() => cur);
    expect((await p.click({ elementIndex: 1 })).ok).toBe(true);
    cur = { actionResults: { click: { ok: false } } };
    expect((await p.click({ elementIndex: 1 })).ok).toBe(false);
  });
});

describe('fileFixtureLoader + resolveMockComputerNativePort（真文件，tmp 隔离）', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('fileFixtureLoader 每次 fresh 读文件（中途改 fixture 立即生效）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cu-mock-'));
    const fx = join(dir, 'computer-mock.json');
    writeFileSync(fx, JSON.stringify({ permissions: { accessibility: 'granted', screenRecording: 'granted' } }));
    const p = new MockComputerNativePort(fileFixtureLoader(dir));
    expect((await p.checkPermissions()).screenRecording).toBe('granted');
    writeFileSync(fx, JSON.stringify({ permissions: { accessibility: 'granted', screenRecording: 'missing' } }));
    expect((await p.checkPermissions()).screenRecording).toBe('missing');
  });

  it('文件缺失 → 空 fixture 走默认（不崩）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cu-mock-'));
    const p = new MockComputerNativePort(fileFixtureLoader(dir)); // 无 computer-mock.json
    expect(await p.checkPermissions()).toEqual({ accessibility: 'granted', screenRecording: 'granted' });
  });

  it('resolveMockComputerNativePort：开关命中建 port / 未命中 undefined', () => {
    expect(resolveMockComputerNativePort({}, '/tmp')).toBeUndefined();
    expect(
      resolveMockComputerNativePort({ ROCKY_TEST_COMPUTER_NATIVE_PORT: 'mock' }, '/tmp'),
    ).toBeInstanceOf(MockComputerNativePort);
  });
});
