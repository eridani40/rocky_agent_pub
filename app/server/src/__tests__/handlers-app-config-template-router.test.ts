/**
 * router 层 sub_agent_templates 端到端 UT（v0.0.28 task-3）
 * 参考: specs/api/overall/10-multi-agent.md §5（CRUD 复用 /config/app/sub_agent_templates + §5.3 DELETE）
 *       specs/tech/multi_agent/[P1]subagent_templates.md §5（explorer 预配）
 *       states/v0.0.28/task.json tasks[2] acceptance「router 新增 DELETE /config/app/sub_agent_templates 路由分发
 *       + explorer 预配 idempotent（bootstrap 后 list 含 explorer builtin:true）」
 *
 * 经 router.handleRequest 黑盒调（验证端到端 JSON 响应 + bootstrap explorer 预配）。
 * 真实落盘：mkdtempSync + afterEach 清理。
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

describe('router sub_agent_templates 端到端（经 handleRequest）', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-app-tmpl-router-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('bootstrap 后 list sub_agent_templates 含 explorer builtin:true（explorer 预配）', async () => {
    // handleRequest 首调触发 bootstrap → upsertExplorerTemplate 写入 explorer record
    const r = await handleRequest(
      req('GET', '/config/app?group=sub_agent_templates'),
      dataDir,
    );
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    const explorer = body.items.find((i: any) => i.key === 'explorer');
    expect(explorer).toBeDefined();
    expect(explorer.data.builtin).toBe(true);
    // 工具清单对齐 spec（无通配符）
    expect(explorer.data.tools).toEqual([
      'read', 'web_search', 'web_fetch', 'send_message',
    ]);
    // modelId=null inherit parent
    expect(explorer.data.modelId).toBeNull();
  });

  it('DELETE /config/app/sub_agent_templates key=explorer → 403 builtin_readonly（builtin 只读）', async () => {
    // 触发 bootstrap（explorer 预配）
    await handleRequest(req('GET', '/config/app?group=sub_agent_templates'), dataDir);
    const r = await handleRequest(
      req('DELETE', '/config/app/sub_agent_templates', { group: 'sub_agent_templates', key: 'explorer' }),
      dataDir,
    );
    expect(r.status).toBe(403);
    expect((await jsonBody(r) as any).error).toBe('builtin_readonly');
  });

  it('DELETE /config/app/sub_agent_templates group=agent → 403 group_not_deletable', async () => {
    await handleRequest(req('GET', '/health'), dataDir);
    const r = await handleRequest(
      req('DELETE', '/config/app/sub_agent_templates', { group: 'agent', key: 'x' }),
      dataDir,
    );
    expect(r.status).toBe(403);
    expect((await jsonBody(r) as any).error).toBe('group_not_deletable');
  });

  it('PUT copy explorer 改名 builtin=false → 200 → DELETE 新 key → 200', async () => {
    await handleRequest(req('GET', '/config/app?group=sub_agent_templates'), dataDir);
    // copy
    const put = await handleRequest(
      req('PUT', '/config/app/sub_agent_templates', {
        group: 'sub_agent_templates',
        key: 'my-explorer',
        data: {
          name: 'my-explorer',
          description: '私有 copy',
          systemPrompt: 'sp',
          tools: ['read'],
          skills: [],
          modelId: null,
          builtin: false,
        },
      }),
      dataDir,
    );
    expect(put.status).toBe(200);
    expect((await jsonBody(put) as any).ok).toBe(true);
    // GET 验证落库
    const get = await handleRequest(
      req('GET', '/config/app?group=sub_agent_templates&key=my-explorer'),
      dataDir,
    );
    expect((await jsonBody(get) as any).value.builtin).toBe(false);
    // DELETE 私有 → 200
    const del = await handleRequest(
      req('DELETE', '/config/app/sub_agent_templates', { group: 'sub_agent_templates', key: 'my-explorer' }),
      dataDir,
    );
    expect(del.status).toBe(200);
    expect((await jsonBody(del))).toEqual({ ok: true });
    // GET 已删 → value:null
    const get2 = await handleRequest(
      req('GET', '/config/app?group=sub_agent_templates&key=my-explorer'),
      dataDir,
    );
    expect((await jsonBody(get2) as any).value).toBeNull();
  });

  it('PUT 新建 builtin:true → 403 builtin_readonly（新建禁止伪装 builtin）', async () => {
    await handleRequest(req('GET', '/health'), dataDir);
    const r = await handleRequest(
      req('PUT', '/config/app/sub_agent_templates', {
        group: 'sub_agent_templates',
        key: 'fake',
        data: {
          name: 'fake', description: 'd', systemPrompt: 'sp',
          tools: ['read'], builtin: true,
        },
      }),
      dataDir,
    );
    expect(r.status).toBe(403);
    expect((await jsonBody(r) as any).error).toBe('builtin_readonly');
  });

  it('DELETE /config/app/sub_agent_templates record 不存在 → 404', async () => {
    await handleRequest(req('GET', '/health'), dataDir);
    const r = await handleRequest(
      req('DELETE', '/config/app/sub_agent_templates', { group: 'sub_agent_templates', key: 'ghost' }),
      dataDir,
    );
    expect(r.status).toBe(404);
  });

  it('DELETE /config/app/sub_agent_templates 非 GET/PUT/DELETE → 405 Allow 含 DELETE', async () => {
    await handleRequest(req('GET', '/health'), dataDir);
    const r = await handleRequest(req('POST', '/config/app/sub_agent_templates'), dataDir);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toContain('DELETE');
  });
});
