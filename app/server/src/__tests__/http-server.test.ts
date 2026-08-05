/**
 * http-server 适配层单测 — 验证 node:http 桥接（Bun-in-Electron 修复）
 * 参考: 本 task 指令（Bun.serve → node:http 运行时可移植）
 *
 * 校验点（端到端真实 socket，证明 startServer 在 bun runtime 下用 node:http 跑通）：
 *   - startServer({ apiPort, dataDir }) 返回 { port, close }
 *   - GET /counter 返回 { value, updatedAt }
 *   - POST /counter/inc 自增
 *   - 响应包含 CORS 头（Access-Control-Allow-Origin: *）
 *   - OPTIONS 预检 → 204 + CORS 头
 *   - 404 / 405 行为
 *   - close() 真正停服
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { startServer, type StartedServer } from '../http-server';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** 找一个空闲端口（startServer 端口 0 = 让 OS 分配，再读 actualPort） */
async function freePort(): Promise<number> {
  return 0;
}

async function get(
  port: number,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe('http-server startServer (node:http 桥接)', () => {
  let dataDir: string;
  let server: StartedServer;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-http-'));
    server = await startServer({
      apiPort: await freePort(),
      dataDir,
    });
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    server.close();
  });

  it('GET /counter 返回 200 + { value, updatedAt }', async () => {
    const r = await get(server.port, '/counter');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { value: number; updatedAt: string };
    expect(body.value).toBe(0);
    expect(body.updatedAt).toMatch(ISO8601);
  });

  it('POST /counter/inc 自增 + 再 GET 一致', async () => {
    const inc = await get(server.port, '/counter/inc', { method: 'POST' });
    expect(((await inc.json()) as { value: number }).value).toBe(1);
    const get1 = await get(server.port, '/counter');
    expect(((await get1.json()) as { value: number }).value).toBe(1);
  });

  it('响应包含 CORS 头 Access-Control-Allow-Origin: *', async () => {
    const r = await get(server.port, '/counter');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-methods')).toContain('GET');
    expect(r.headers.get('access-control-allow-methods')).toContain('POST');
    expect(r.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('OPTIONS 预检返回 204 + CORS 头', async () => {
    const r = await get(server.port, '/counter', { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('OPTIONS 任意路径都返回 204 + CORS（即便 404 路径）', async () => {
    const r = await get(server.port, '/nope', { method: 'OPTIONS' });
    expect(r.status).toBe(204);
  });

  it('未匹配路径 404 { error: "Not Found" }', async () => {
    const r = await get(server.port, '/unknown');
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe('Not Found');
  });

  it('PUT /counter 返回 405 + Allow: GET', async () => {
    const r = await get(server.port, '/counter', { method: 'PUT' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
  });

  it('close() 后端口不再可连', async () => {
    server.close();
    await expect(get(server.port, '/counter')).rejects.toThrow();
  });

  // 事件循环监控接线 —— 开关开时启动不被监控破坏（Bun 不支持 monitorEventLoopDelay
  //   时静默降级也不 throw）；开关默认关（上面全部用例即零副作用验证：无 env 直接启动）。
  it('EVENT_LOOP_MONITOR=1 时 startServer 正常启动并可服务（监控绝不阻断启动）', async () => {
    const prev = process.env.EVENT_LOOP_MONITOR;
    process.env.EVENT_LOOP_MONITOR = '1';
    try {
      const s = await startServer({ apiPort: 0, dataDir });
      const r = await get(s.port, '/counter');
      expect(r.status).toBe(200);
      s.close();
    } finally {
      if (prev === undefined) delete process.env.EVENT_LOOP_MONITOR;
      else process.env.EVENT_LOOP_MONITOR = prev;
    }
  });
});
