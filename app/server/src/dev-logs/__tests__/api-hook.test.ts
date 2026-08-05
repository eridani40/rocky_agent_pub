/**
 * api hook 单测（spec dev-logs §3.3）
 * 参考: specs/tech/app/dev-logs/[P0]overall.md §3.3 §7
 *
 * 校验点：
 *   - 开关 on：handleRequest 产一条 {method, path, status, requestBody, responseBody}
 *   - 开关 off：不写（零开销：先读开关 false 直接 return 不 clone 不读 body）
 *   - 排除 /sse、/sse/*、/health（不写）
 *
 * 测试方式：真实 bootstrap（mkdtemp dataDir），devConfig.set 控制开关。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { handleRequest } from '../../router';

async function flushAppend(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

function readJsonl(p: string): Record<string, unknown>[] {
  if (!existsSync(p)) return []; // 文件不存在 = 零记录（排除项测试：所有请求都被排除时不会有文件）
  const content = readFileSync(p, 'utf-8').trim();
  if (content.length === 0) return [];
  return content.split('\n').map((l) => JSON.parse(l));
}

describe('api hook（handleRequest 级，spec dev-logs §3.3）', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-apihook-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('开关 off：不写 api.log（零开销）', async () => {
    // 触发一次请求（/health 排除项 + /counter 普通项都应不写，因开关 off）
    const r = await handleRequest(new Request(`http://x/counter`, { method: 'GET' }), dataDir);
    expect(r.status).toBe(200);
    await flushAppend();
    expect(existsSync(join(dataDir, 'logs', 'api.log'))).toBe(false);
  });

  it('开关 on：GET /counter 产一条 {method, path, status, responseBody}', async () => {
    // 先触发一次 bootstrap（让 devConfig 可用），再 set 开关
    await handleRequest(new Request(`http://x/counter`, { method: 'GET' }), dataDir);
    // 通过 devConfig handler set 开关（走真实持久化路径）
    const putResp = await handleRequest(
      new Request(`http://x/config/app`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group: 'logs', items: [{ key: 'enableAppApiLog', data: true }] }),
      }),
      dataDir,
    );
    expect(putResp.status).toBe(200);
    // 再发一次普通请求 → 应写日志
    const r = await handleRequest(new Request(`http://x/counter`, { method: 'GET' }), dataDir);
    expect(r.status).toBe(200);
    await flushAppend();
    const lines = readJsonl(join(dataDir, 'logs', 'api.log'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // 找到 method=GET path=/counter 的记录
    const hit = lines.find((l) => l.method === 'GET' && l.path === '/counter');
    expect(hit).toBeTruthy();
    expect(hit!.method).toBe('GET');
    expect(hit!.path).toBe('/counter');
    expect(hit!.status).toBe(200);
    // GET 无 body，requestBody 省略（不写 requestBody 字段）
    expect(hit!.requestBody).toBeUndefined();
    // responseBody 是 raw text（http原文，不再 parse JSON）
    expect(typeof hit!.responseBody).toBe('string');
    expect(hit!.responseBody as string).toContain('value');
  });

  it('排除 /health：开关 on 也不写 health 请求', async () => {
    await handleRequest(new Request(`http://x/counter`, { method: 'GET' }), dataDir);
    await handleRequest(
      new Request(`http://x/config/app`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group: 'logs', items: [{ key: 'enableAppApiLog', data: true }] }),
      }),
      dataDir,
    );
    const r = await handleRequest(new Request(`http://x/health`, { method: 'GET' }), dataDir);
    expect(r.status).toBe(200);
    await flushAppend();
    const lines = readJsonl(join(dataDir, 'logs', 'api.log'));
    // 无 path=/health 记录
    expect(lines.find((l) => l.path === '/health')).toBeUndefined();
  });

  it('排除 /sse、/sse/*：开关 on 也不写 sse 请求', async () => {
    await handleRequest(new Request(`http://x/counter`, { method: 'GET' }), dataDir);
    await handleRequest(
      new Request(`http://x/config/app`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group: 'logs', items: [{ key: 'enableAppApiLog', data: true }] }),
      }),
      dataDir,
    );
    // /sse 是 GET（handleSseStream 返 streaming Response）
    await handleRequest(new Request(`http://x/sse`, { method: 'GET' }), dataDir);
    await handleRequest(new Request(`http://x/sse/subscribe`, { method: 'POST' }), dataDir);
    await flushAppend();
    const lines = readJsonl(join(dataDir, 'logs', 'api.log'));
    expect(lines.find((l) => l.path === '/sse')).toBeUndefined();
    expect(lines.find((l) => l.path === '/sse/subscribe')).toBeUndefined();
  });

  it('带 body 请求：开关 on 时记 requestBody raw text（dispatch 前 clone 修复）', async () => {
    await handleRequest(new Request(`http://x/counter`, { method: 'GET' }), dataDir);
    await handleRequest(
      new Request(`http://x/config/app`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group: 'logs', items: [{ key: 'enableAppApiLog', data: true }] }),
      }),
      dataDir,
    );
    // 开关 on 后，再发一个带 body 的 PUT（验 dispatch 前 clone 读到 raw text 原文，非 null/空）
    const bodyText = JSON.stringify({ group: 'logs', items: [{ key: 'enableEventLog', data: true }] });
    const r = await handleRequest(
      new Request(`http://x/config/app`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: bodyText,
      }),
      dataDir,
    );
    expect(r.status).toBe(200);
    await flushAppend();
    const lines = readJsonl(join(dataDir, 'logs', 'api.log'));
    // 最后一条 PUT /config/app = 开关 on 之后那条；requestBody 应为 raw text 原文
    const puts = lines.filter((l) => l.method === 'PUT' && l.path === '/config/app');
    const hit = puts[puts.length - 1];
    expect(hit).toBeTruthy();
    expect(hit!.requestBody).toBe(bodyText);
  });
});
