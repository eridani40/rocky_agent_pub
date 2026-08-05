/**
 * provider handlers 单测 — /provider + /provider/:id/model CRUD（经 router 全链路）
 * 参考: specs/api/overall/02-llm-chat.md §5
 *       AT: provider/provider_crud_tc1 + provider/model_crud_tc1
 *
 * 校验点：
 *   - POST /provider → 201，credentials.key 响应返回明文（BUG-002 修复）
 *   - GET /provider → 200 items，每项 credentials.key 返回明文
 *   - PUT credentials.key===*** 视为不修改（向后兼容哨兵，响应返回原 key 明文）
 *   - GET /provider/:id → 200 单个，credentials.key 返回明文
 *   - DELETE /provider/:id → 200 ok；再 GET → 404
 *   - POST/GET/PUT/DELETE /provider/:id/model + 409 重复 + 404 未命中
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

describe('provider handlers (经 router)', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'rocky-prov-h-')); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  async function createProvider(): Promise<string> {
    const r = await handleRequest(req('POST', '/provider', {
      name: 'anthropic_compatible',
      protocolId: 'anthropic_messages', // [v0.0.53] 必填
      label: 'My Anthropic',
      baseUrl: 'https://api.anthropic.com',
      credentials: { key: 'sk-secret-12345' },
    }), dataDir);
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    // BUG-002 修复：创建后响应返回明文 key
    expect(body.provider.credentials.key).toBe('sk-secret-12345');
    return body.provider.id;
  }

  it('POST/GET/PUT/DELETE /provider，credentials 响应脱敏（provider_crud_tc1）', async () => {
    const id = await createProvider();
    // GET 列表
    const list = await handleRequest(req('GET', '/provider'), dataDir);
    expect(list.status).toBe(200);
    const lb = await jsonBody(list);
    // BUG-002 修复：GET 列表返回明文 key
    expect(lb.items[0].credentials.key).toBe('sk-secret-12345');
    // PUT key=*** 不修改（向后兼容哨兵）+ label 更新；响应返回原 key 明文
    const put = await handleRequest(req('PUT', `/provider/${id}`, {
      label: 'Renamed', credentials: { key: '***' },
    }), dataDir);
    expect(put.status).toBe(200);
    const pb = await jsonBody(put);
    expect(pb.provider.label).toBe('Renamed');
    // key=*** 哨兵：原 key 未被覆盖，返回原明文
    expect(pb.provider.credentials.key).toBe('sk-secret-12345');
    // GET 单个，响应返回明文
    const get = await handleRequest(req('GET', `/provider/${id}`), dataDir);
    expect(get.status).toBe(200);
    expect((await jsonBody(get)).provider.credentials.key).toBe('sk-secret-12345');
    // PUT 真 key 更新，响应返回新明文 key
    const putKey = await handleRequest(req('PUT', `/provider/${id}`, {
      credentials: { key: 'sk-new-real-key' },
    }), dataDir);
    expect(putKey.status).toBe(200);
    expect((await jsonBody(putKey)).provider.credentials.key).toBe('sk-new-real-key');
    // DELETE
    const del = await handleRequest(req('DELETE', `/provider/${id}`), dataDir);
    expect(del.status).toBe(200);
    expect((await jsonBody(del)).ok).toBe(true);
    // 再 GET → 404
    const notFound = await handleRequest(req('GET', `/provider/${id}`), dataDir);
    expect(notFound.status).toBe(404);
  });

  it('POST /provider 缺必填返 400', async () => {
    const r = await handleRequest(req('POST', '/provider', { name: 'anthropic_compatible' }), dataDir);
    expect(r.status).toBe(400);
  });

  it('/provider/:id/model CRUD + 409 重复 + 404（model_crud_tc1）', async () => {
    const pid = await createProvider();
    // POST model
    const m1 = await handleRequest(req('POST', `/provider/${pid}/model`, {
      modelId: 'claude-test', protocolId: 'anthropic_messages',
      contextWindow: 200000, maxOutputTokens: 4096,
    }), dataDir);
    expect(m1.status).toBe(201);
    const m1b = await jsonBody(m1);
    expect(m1b.model.modelId).toBe('claude-test');
    // 重复 POST → 409
    const dup = await handleRequest(req('POST', `/provider/${pid}/model`, {
      modelId: 'claude-test', protocolId: 'anthropic_messages',
    }), dataDir);
    expect(dup.status).toBe(409);
    // GET 列表
    const list = await handleRequest(req('GET', `/provider/${pid}/model`), dataDir);
    expect(list.status).toBe(200);
    expect((await jsonBody(list)).items[0].modelId).toBe('claude-test');
    // PUT 更新
    const put = await handleRequest(req('PUT', `/provider/${pid}/model/claude-test`, {
      maxOutputTokens: 8192,
    }), dataDir);
    expect(put.status).toBe(200);
    expect((await jsonBody(put)).model.maxOutputTokens).toBe(8192);
    // DELETE
    const del = await handleRequest(req('DELETE', `/provider/${pid}/model/claude-test`), dataDir);
    expect(del.status).toBe(200);
    expect((await jsonBody(del)).ok).toBe(true);
    // PUT 未命中 → 404
    const nf = await handleRequest(req('PUT', `/provider/${pid}/model/claude-test`, { maxOutputTokens: 1 }), dataDir);
    expect(nf.status).toBe(404);
  });

  it('GET /provider/:id/model 未命中 provider → 404', async () => {
    const r = await handleRequest(req('GET', '/provider/01NOTEXIST/model'), dataDir);
    expect(r.status).toBe(404);
  });

  it('GET /provider 对缺 id 的脏 record 防御性补合法 id（ET undefined/claude-mock-1 观察）', async () => {
    // 模拟历史脏数据：直接 PUT /config/app providers 组写一个无 id 的 record
    // （某些测试夹具 / 旧版本数据可能漏填 id，导致 UI model picker 显示 undefined/<modelId>）
    await handleRequest(req('PUT', '/config/app', {
      group: 'providers',
      key: 'dirty-no-id',
      data: {
        // 故意缺 id 字段
        name: 'anthropic_compatible',
        label: 'Mock Provider',
        baseUrl: 'https://api.anthropic.com',
        credentials: { key: 'sk-test' },
        enabled: true,
        models: [{
          modelId: 'claude-mock-1', protocolId: 'anthropic_messages',
          contextWindow: 200000, maxOutputTokens: 4096,
        }],
      },
    }), dataDir);

    const list = await handleRequest(req('GET', '/provider'), dataDir);
    expect(list.status).toBe(200);
    const lb = await jsonBody(list);
    expect(lb.items.length).toBe(1);
    // 防御性补全：缺 id 的 record 出口必有合法非空 string id（UI 不再显示 undefined）
    expect(typeof lb.items[0].id).toBe('string');
    expect(lb.items[0].id.length).toBeGreaterThan(0);
  });
});
