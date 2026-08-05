/**
 * LoopbackComputerNativePort 单测 —— 纯 fetch 调主进程通道 + fail-closed
 * 参考: app/server/src/platform/computer/loopback-native-port.ts
 *       change_plan_v2 §5.5 P0-G（dev loopback 通道）
 *
 * 守护：零 electron（纯 global fetch）；fetch 抛/非 2xx 一律 fail-closed（不崩不抛穿 tool）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LoopbackComputerNativePort,
  resolveLoopbackComputerNativePort,
} from '../loopback-native-port';

/** 造一个最小 Response-like（含 ok/status/json） */
function jsonResponse(status: number, body: unknown): Partial<Response> {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('LoopbackComputerNativePort', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('checkPermissions：GET /permissions 带 token header → 归一化两态', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { accessibility: 'granted', screenRecording: 'missing' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect(await p.checkPermissions()).toEqual({ accessibility: 'granted', screenRecording: 'missing' });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://127.0.0.1:3719/permissions');
    expect((call[1].headers as Record<string, string>)['x-rocky-dev-token']).toBe('tok');
  });

  it('checkPermissions：fetch 抛 → 双 missing（fail-closed 不崩）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect(await p.checkPermissions()).toEqual({ accessibility: 'missing', screenRecording: 'missing' });
  });

  it('checkPermissions：非 2xx → 双 missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, {})));
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect(await p.checkPermissions()).toEqual({ accessibility: 'missing', screenRecording: 'missing' });
  });

  it('screenshot：POST /screenshot → 透传 ComputerScreenshotResult', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, mediaType: 'image/png', data: 'AAAA', width: 2, height: 2 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect(await p.screenshot()).toEqual({ ok: true, mediaType: 'image/png', data: 'AAAA', width: 2, height: 2 });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://127.0.0.1:3719/screenshot');
    expect(call[1].method).toBe('POST');
  });

  it('screenshot：fetch 抛 → {ok:false,reason}（fail-closed）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    const r = await p.screenshot();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('boom');
  });

  it('screenshot：malformed（无 ok 字段）→ ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: 'x' })));
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect((await p.screenshot()).ok).toBe(false);
  });

  it('readAxTree：POST /invoke {method:readAxTree} → 透传 AxTreeResult', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, text: 'TREE', scaleFactor: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect(await p.readAxTree({ app: 'Notes' })).toEqual({ ok: true, text: 'TREE', scaleFactor: 2 });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://127.0.0.1:3719/invoke');
    expect(JSON.parse(call[1].body as string)).toEqual({ method: 'readAxTree', params: [{ app: 'Notes' }] });
  });

  it('readAxTree：fetch 抛 → {ok:false,reason}（fail-closed）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    const r = await p.readAxTree();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('boom');
  });

  it('click：POST /invoke {method:click, params:[target,opts]} → 透传 ComputerActionResult', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect(await p.click({ elementIndex: 3 }, { button: 'right' })).toEqual({ ok: true });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toEqual({
      method: 'click',
      params: [{ elementIndex: 3 }, { button: 'right' }],
    });
  });

  it('click：非 2xx → {ok:false,reason}（fail-closed）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {})));
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect((await p.click({ elementIndex: 1 })).ok).toBe(false);
  });

  it('type/scroll/pressKey：走 /invoke，透传 action 成败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true })));
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect((await p.type('hi')).ok).toBe(true);
    expect((await p.scroll({ elementIndex: 1 }, { direction: 'down' })).ok).toBe(true);
    expect((await p.pressKey('cmd+s')).ok).toBe(true);
  });

  it('action malformed（无 ok 字段）→ ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { foo: 'bar' })));
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect((await p.pressKey('enter')).ok).toBe(false);
  });

  it('getAppState：POST /invoke {method:getAppState} → 透传 GetAppStateResult', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, axText: 'TREE', pid: 42, scaleFactor: 2 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect(await p.getAppState({ app: 'Notes' })).toEqual({ ok: true, axText: 'TREE', pid: 42, scaleFactor: 2 });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toEqual({ method: 'getAppState', params: [{ app: 'Notes' }] });
  });

  it('getAppState：fetch 抛 → {ok:false,reason}（fail-closed）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect((await p.getAppState()).ok).toBe(false);
  });

  it('listApps：POST /invoke {method:listApps} → 透传数组', async () => {
    const apps = [{ bundleId: 'com.apple.Safari', name: 'Safari', pid: 501, isRunning: true }];
    const fetchMock = vi.fn(async () => jsonResponse(200, apps));
    vi.stubGlobal('fetch', fetchMock);
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect(await p.listApps()).toEqual(apps);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toEqual({ method: 'listApps', params: [] });
  });

  it('listApps：非数组/fetch 抛 → 空数组（fail-closed 不阻断）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { not: 'array' })));
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect(await p.listApps()).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    expect(await p.listApps()).toEqual([]);
  });

  it('drag/setValue/performSecondaryAction：走 /invoke，透传 action 成败 + params', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new LoopbackComputerNativePort('http://127.0.0.1:3719', 'tok');
    expect((await p.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, { app: 'S' })).ok).toBe(true);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      method: 'drag',
      params: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { app: 'S' }],
    });
    expect((await p.setValue(4, 'v')).ok).toBe(true);
    // opts=undefined 经 JSON.stringify 在数组中序列化为 null
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      method: 'setValue',
      params: [4, 'v', null],
    });
    expect((await p.performSecondaryAction(2, 'Raise')).ok).toBe(true);
    expect(JSON.parse((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      method: 'performSecondaryAction',
      params: [2, 'Raise', null],
    });
  });
});

describe('resolveLoopbackComputerNativePort', () => {
  it('无 ROCKY_DEV_COMPUTER_LOOPBACK_PORT → undefined', () => {
    expect(resolveLoopbackComputerNativePort({})).toBeUndefined();
  });
  it('有 port → LoopbackComputerNativePort 实例', () => {
    expect(
      resolveLoopbackComputerNativePort({
        ROCKY_DEV_COMPUTER_LOOPBACK_PORT: '3719',
        ROCKY_DEV_COMPUTER_LOOPBACK_TOKEN: 't',
      }),
    ).toBeInstanceOf(LoopbackComputerNativePort);
  });
});
