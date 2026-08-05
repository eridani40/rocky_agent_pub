/**
 * [v0.0.53] provider handlers 单测 — protocolId 校验 + GET 响应扩 protocols + body 忽略 model.protocolId
 * 参考: specs/api/overall/02-llm-chat.md §5.4（v0.0.53 protocolId 合法性校验 + body 忽略）
 *       task 2 acceptanceCriteria §3/§4/§5
 *
 * 校验点：
 *   - GET /provider 响应 = { items, protocols: ProtocolMeta[] }；protocols[0] 含 id/label/path 三字段
 *   - POST /provider 缺 protocolId → 400
 *   - POST /provider protocolId 非法（不在已注册集合）→ 400 + error 提及 protocolId
 *   - POST /provider/:id/model body 含 protocolId → 忽略 201；响应 model 无 protocolId 字段
 *
 * 经 router.handleRequest 走通整链路（含 bootstrap → 真实 PluginManager 注入 llm_protocol ext impl）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { handleRequest } from '../router';

function req(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://127.0.0.1:3700${path}`, init);
}
async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

describe('[v0.0.53] provider handlers — protocolId 校验 + protocols metadata', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'rocky-prov-v053-')); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('GET /provider 响应顶层含 protocols: ProtocolMeta[]（id/label/path 三字段）', async () => {
    const r = await handleRequest(req('GET', '/provider'), dataDir);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(Array.isArray(body.protocols)).toBe(true);
    expect(body.protocols.length).toBeGreaterThan(0);
    const p0 = body.protocols[0];
    expect(p0.id).toBe('anthropic_messages');
    expect(typeof p0.label).toBe('string');
    expect(p0.label.length).toBeGreaterThan(0);
    expect(typeof p0.path).toBe('string');
    expect(p0.path).toBe('/v1/messages');
  });

  it('POST /provider 缺 protocolId → 400', async () => {
    const r = await handleRequest(req('POST', '/provider', {
      name: 'anthropic_compatible',
      label: 'No Protocol',
      baseUrl: 'https://api.anthropic.com',
      credentials: { key: 'sk-x' },
    }), dataDir);
    expect(r.status).toBe(400);
    const body = await jsonBody(r);
    expect(body.error).toMatch(/protocolId/);
  });

  it('POST /provider protocolId 非法（"unknown_protocol"）→ 400 + error 提及 protocolId', async () => {
    const r = await handleRequest(req('POST', '/provider', {
      name: 'anthropic_compatible',
      protocolId: 'unknown_protocol',
      label: 'Bad Protocol',
      baseUrl: 'https://api.anthropic.com',
      credentials: { key: 'sk-x' },
    }), dataDir);
    expect(r.status).toBe(400);
    const body = await jsonBody(r);
    expect(body.error).toMatch(/protocolId/);
    expect(body.error).toContain('unknown_protocol');
  });

  it('POST /provider 合法 protocolId → 201 + 顶层回显', async () => {
    const r = await handleRequest(req('POST', '/provider', {
      name: 'anthropic_compatible',
      protocolId: 'anthropic_messages',
      label: 'Good',
      baseUrl: 'https://api.anthropic.com',
      credentials: { key: 'sk-x' },
    }), dataDir);
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    expect(body.provider.protocolId).toBe('anthropic_messages');
    return body.provider.id as string;
  });

  it('POST /provider/:id/model body 含 protocolId → 忽略 201；响应 model 无 protocolId 字段', async () => {
    // 先建 provider
    const p = await handleRequest(req('POST', '/provider', {
      name: 'anthropic_compatible',
      protocolId: 'anthropic_messages',
      label: 'P',
      baseUrl: 'x',
      credentials: { key: 'k' },
    }), dataDir);
    const pid = (await jsonBody(p)).provider.id;
    // POST model 带 protocolId（应被忽略）
    const m = await handleRequest(req('POST', `/provider/${pid}/model`, {
      modelId: 'm1',
      protocolId: 'anthropic_messages', // 应被忽略
      contextWindow: 200000,
      maxOutputTokens: 4096,
    }), dataDir);
    expect(m.status).toBe(201);
    const mb = await jsonBody(m);
    expect(mb.model.modelId).toBe('m1');
    // [v0.0.53] model 无 protocolId 字段（迁出 → ProviderInstance.protocolId）
    expect('protocolId' in mb.model).toBe(false);
  });

  it('POST /provider/:id/model body 无 protocolId → 201 正常（model 无 protocolId）', async () => {
    const p = await handleRequest(req('POST', '/provider', {
      name: 'anthropic_compatible',
      protocolId: 'anthropic_messages',
      label: 'P',
      baseUrl: 'x',
      credentials: { key: 'k' },
    }), dataDir);
    const pid = (await jsonBody(p)).provider.id;
    const m = await handleRequest(req('POST', `/provider/${pid}/model`, {
      modelId: 'm2',
      contextWindow: 200000,
      maxOutputTokens: 4096,
    }), dataDir);
    expect(m.status).toBe(201);
    const mb = await jsonBody(m);
    expect('protocolId' in mb.model).toBe(false);
  });

  it('PUT /provider/:id 改 protocolId（合法新值，验证部分更新）', async () => {
    const p = await handleRequest(req('POST', '/provider', {
      name: 'anthropic_compatible',
      protocolId: 'anthropic_messages',
      label: 'P',
      baseUrl: 'x',
      credentials: { key: 'k' },
    }), dataDir);
    const pid = (await jsonBody(p)).provider.id;
    // PUT 同值（当前唯一合法 protocolId）→ 200 回显
    const put = await handleRequest(req('PUT', `/provider/${pid}`, {
      protocolId: 'anthropic_messages',
    }), dataDir);
    expect(put.status).toBe(200);
    const body = await jsonBody(put);
    expect(body.provider.protocolId).toBe('anthropic_messages');
  });

  it('PUT /provider/:id protocolId 非法 → 400', async () => {
    const p = await handleRequest(req('POST', '/provider', {
      name: 'anthropic_compatible',
      protocolId: 'anthropic_messages',
      label: 'P',
      baseUrl: 'x',
      credentials: { key: 'k' },
    }), dataDir);
    const pid = (await jsonBody(p)).provider.id;
    const put = await handleRequest(req('PUT', `/provider/${pid}`, {
      protocolId: 'totally_unknown',
    }), dataDir);
    expect(put.status).toBe(400);
    const body = await jsonBody(put);
    expect(body.error).toMatch(/protocolId/);
  });
});
