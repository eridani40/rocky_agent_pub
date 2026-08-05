/**
 * computer-loopback-server 单测 —— routeLoopback token 门禁 + 路由（含 /invoke 泛路由）+ 异常兜底
 * 参考: app/electron/src/computer-loopback-server.ts
 *       change_plan_v2 §5.5 P0-G（127.0.0.1 + token 校验）+ change_plan_v2_batch2 §P1-D（/invoke）
 */
import { describe, it, expect } from 'vitest';
import { routeLoopback } from '../computer-loopback-server';
import type { ElectronComputerNativePort } from '../computer-native-port';

/** 构造完整 fake port（记录 /invoke 分发的方法名 + 参数，验泛路由 spread） */
function makeFakePort(over: Partial<ElectronComputerNativePort> = {}): {
  port: ElectronComputerNativePort;
  invoked: Array<{ method: string; args: unknown[] }>;
} {
  const invoked: Array<{ method: string; args: unknown[] }> = [];
  const rec =
    (method: string) =>
    async (...args: unknown[]) => {
      invoked.push({ method, args });
      return { ok: true } as unknown;
    };
  const port = {
    checkPermissions: async () => ({ accessibility: 'granted', screenRecording: 'missing' }),
    screenshot: async () => ({ ok: true, mediaType: 'image/png', data: 'ABC', width: 1, height: 1 }),
    getAppState: rec('getAppState'),
    readAxTree: rec('readAxTree'),
    listApps: rec('listApps'),
    click: rec('click'),
    type: rec('type'),
    scroll: rec('scroll'),
    pressKey: rec('pressKey'),
    drag: rec('drag'),
    setValue: rec('setValue'),
    performSecondaryAction: rec('performSecondaryAction'),
    ...over,
  } as unknown as ElectronComputerNativePort;
  return { port, invoked };
}

describe('routeLoopback — token 门禁', () => {
  const { port } = makeFakePort();
  it('token 缺 → 403', async () => {
    expect((await routeLoopback('GET', '/permissions', undefined, 'tok', port)).status).toBe(403);
  });
  it('token 错 → 403', async () => {
    expect((await routeLoopback('GET', '/permissions', 'wrong', 'tok', port)).status).toBe(403);
  });
  it('expectedToken 空 → 403（fail-closed，即便 header 也空）', async () => {
    expect((await routeLoopback('GET', '/permissions', '', '', port)).status).toBe(403);
  });
});

describe('routeLoopback — 专属路由', () => {
  const { port } = makeFakePort();
  it('GET /permissions（token 对）→ 200 + permissions', async () => {
    const r = await routeLoopback('GET', '/permissions', 'tok', 'tok', port);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ accessibility: 'granted', screenRecording: 'missing' });
  });
  it('POST /screenshot（token 对）→ 200 + result', async () => {
    const r = await routeLoopback('POST', '/screenshot', 'tok', 'tok', port);
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
  });
  it('query string 容错（/permissions?x=1）→ 200', async () => {
    expect((await routeLoopback('GET', '/permissions?x=1', 'tok', 'tok', port)).status).toBe(200);
  });
  it('未知路由 → 404', async () => {
    expect((await routeLoopback('GET', '/nope', 'tok', 'tok', port)).status).toBe(404);
  });
  it('方法不匹配（GET /screenshot）→ 404', async () => {
    expect((await routeLoopback('GET', '/screenshot', 'tok', 'tok', port)).status).toBe(404);
  });
});

describe('routeLoopback — /invoke 泛路由', () => {
  it('已知 method + params → spread 分发到 port 方法', async () => {
    const { port, invoked } = makeFakePort();
    const body = { method: 'click', params: [{ elementIndex: 3 }, { app: 'Finder' }] };
    const r = await routeLoopback('POST', '/invoke', 'tok', 'tok', port, body);
    expect(r.status).toBe(200);
    expect(invoked[0]).toEqual({ method: 'click', args: [{ elementIndex: 3 }, { app: 'Finder' }] });
  });
  it('readAxTree 无 params → 空数组分发（opts undefined）', async () => {
    const { port, invoked } = makeFakePort();
    const r = await routeLoopback('POST', '/invoke', 'tok', 'tok', port, { method: 'readAxTree' });
    expect(r.status).toBe(200);
    expect(invoked[0]).toEqual({ method: 'readAxTree', args: [] });
  });
  it('未知 method → 404（白名单校验，不调 port 任意属性）', async () => {
    const { port, invoked } = makeFakePort();
    const r = await routeLoopback('POST', '/invoke', 'tok', 'tok', port, { method: 'checkPermissions' });
    expect(r.status).toBe(404);
    expect(invoked).toHaveLength(0);
  });
  it('缺 method → 404', async () => {
    const { port } = makeFakePort();
    expect((await routeLoopback('POST', '/invoke', 'tok', 'tok', port, {})).status).toBe(404);
  });
});

describe('routeLoopback — 异常兜底', () => {
  it('port 抛 → 500 + {ok:false,reason}', async () => {
    const { port } = makeFakePort({
      checkPermissions: async () => {
        throw new Error('kaboom');
      },
    });
    const r = await routeLoopback('GET', '/permissions', 'tok', 'tok', port);
    expect(r.status).toBe(500);
    expect((r.body as { reason: string }).reason).toContain('kaboom');
  });
});
