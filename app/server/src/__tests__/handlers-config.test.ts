/**
 * config handler 单测 — /config/{app,dev,plugin} GET/PUT
 * 参考: specs/api/overall/02-llm-chat.md §4
 *       AT: config/app_theme_tc1 / dev_llm_tc1 / plugin_inventory_tc1
 *
 * 经 router.handleRequest 黑盒调（验证端到端 JSON 响应）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { handleRequest } from '../router';
import { flattenImpls } from '../plugin/__tests__/test-helpers';

function req(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://127.0.0.1:3700${path}`, init);
}
async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

describe('config handlers (经 router)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-cfg-h-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('GET /config/app?group=appearance&key=theme 首次返回 value:null', async () => {
    const r = await handleRequest(req('GET', '/config/app?group=appearance&key=theme'), dataDir);
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).value).toBeNull();
  });

  it('PUT /config/app 写 theme=light 后 GET 一致（app_theme_tc1）', async () => {
    const put = await handleRequest(
      req('PUT', '/config/app', { group: 'appearance', key: 'theme', data: 'light' }),
      dataDir,
    );
    expect(put.status).toBe(200);
    expect((await jsonBody(put)).ok).toBe(true);
    const get = await handleRequest(req('GET', '/config/app?group=appearance&key=theme'), dataDir);
    expect((await jsonBody(get)).value).toBe('light');
  });

  // [v0.0.89] 历史 dev_llm_tc1 测试已删除：dev_config/llm_request/{stall_timeout_s,max_retry_times}
  // 是 v0.0.25 前死数据（代码零引用，真配置在 app_config/llm_request/default 走 /config/app/llm_request）。
  // dev_config 废弃后该路径不存在；migration script 会显式 skip 这两条死数据（详见 PRD 05 §3.2）。

  it('GET /config/plugin raw 含 llm_provider/llm_protocol/anthropic（plugin_inventory_tc1 兼容断言）', async () => {
    // v0.0.4 group-centric：tree.groups[].extImpls[]（pointId=llm_provider/llm_protocol，implId 含 anthropic）。
    // 精确结构断言见下条；此条保留 raw 子串断言用于 grep 友好的烟雾测试。
    const get = await handleRequest(req('GET', '/config/plugin'), dataDir);
    expect(get.status).toBe(200);
    const raw = await get.text();
    expect(raw).toContain('llm_provider');
    expect(raw).toContain('llm_protocol');
    expect(raw).toContain('anthropic');
  });

  it('v0.0.67 task3 PUT setImplEnabled 已删 → 405（写路径全删，配置只读化）', async () => {
    // 用户指示「直接删写端点，不返 405」在 handler 层返 405，路由层仍透传到 handler
    const put = await handleRequest(
      req('PUT', '/config/plugin', { op: 'setImplEnabled', implId: 'anthropic_messages', enabled: false }),
      dataDir,
    );
    expect(put.status).toBe(405);
    const get = await handleRequest(req('GET', '/config/plugin'), dataDir);
    const raw = await get.text();
    // inventory enabled 来自代码声明（未声明 disabled → true）
    expect(raw).toMatch(/"implId"\s*:\s*"anthropic_messages"[^}]*"enabled"\s*:\s*true/);
  });

  it('GET /config/plugin 返回 group-centric 结构（v0.0.71 D3 嵌套：groups[].points[].impls[]）', async () => {
    // T3：handler 透传 PluginConfigService.inventory() 的 group-centric 返回。
    // v0.0.71 D3：契约改为 { tree: { groups: [{ groupId, points: [{ pointId, activated, impls: [...] }] }] } }
    //   详见 specs/api/version_logs/v0.0.71.md（破坏性 schema 变更，扁平 extImpls[] 已删）
    const get = await handleRequest(req('GET', '/config/plugin'), dataDir);
    expect(get.status).toBe(200);
    const body = await jsonBody(get);
    // 外层壳保持 v0.0.3：包 tree
    expect(body.tree).toBeDefined();
    // v0.0.4 group-centric：tree.groups[]
    expect(Array.isArray(body.tree.groups)).toBe(true);
    expect(body.tree.groups.length).toBeGreaterThan(0);
    // 首组 groupId='provider'（llm_provider / llm_protocol EP 归属 provider，groups.json 声明）
    const providerGroup = body.tree.groups.find((g: any) => g.groupId === 'provider');
    expect(providerGroup).toBeDefined();
    // v0.0.71 D3 嵌套：拍平 points[].impls[] 后含 anthropic_compatible + anthropic_messages
    const flat = flattenImpls<any>([providerGroup]);
    const implIds = flat.map((e: any) => e.implId);
    expect(implIds).toContain('anthropic_compatible');
    expect(implIds).toContain('anthropic_messages');
    // 每 ext impl 携带 pluginEnabled / enabled（两级 enabled 门）
    for (const ext of flat) {
      expect(typeof ext.pluginEnabled).toBe('boolean');
      expect(typeof ext.enabled).toBe('boolean');
      expect(typeof ext.pluginId).toBe('string');
      expect(typeof ext.pointId).toBe('string');
    }
  });

  it('PUT /config/app 缺字段返 400', async () => {
    const r = await handleRequest(req('PUT', '/config/app', { group: 'appearance' }), dataDir);
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBeTruthy();
  });

  it('v0.0.67 task3 PUT /config/plugin 已删 → 405（任意 op，含未知 op）', async () => {
    // 写端点已删，PUT 任何 body 都返 405（不再走 op 分发）
    const r = await handleRequest(
      req('PUT', '/config/plugin', { op: 'unknown' }),
      dataDir,
    );
    expect(r.status).toBe(405);
  });

  // [v0.0.5 bugfix BUG-002] 历史 PUT setExclusive / setOrder op 分支单测
  // v0.0.67 task3：PUT 端点删，所有 op 一律返 405（不再有 op 分支）
  it('v0.0.67 task3 PUT op=setExclusive → 405（写端点已删）', async () => {
    const put = await handleRequest(
      req('PUT', '/config/plugin', { op: 'setExclusive', implId: 'anthropic_compatible' }),
      dataDir,
    );
    expect(put.status).toBe(405);
  });

  it('v0.0.67 task3 PUT op=setExclusive 缺 implId → 405（不再做 body 校验）', async () => {
    const r = await handleRequest(req('PUT', '/config/plugin', { op: 'setExclusive' }), dataDir);
    expect(r.status).toBe(405);
  });

  it('v0.0.67 task3 PUT op=setOrder → 405（写端点已删）', async () => {
    const put = await handleRequest(
      req('PUT', '/config/plugin', { op: 'setOrder', implId: 'anthropic_compatible', order: 5 }),
      dataDir,
    );
    expect(put.status).toBe(405);
    // GET 仍正常（读路径不受影响）；effective order 来自代码声明，单 impl → 1
    const get = await handleRequest(req('GET', '/config/plugin'), dataDir);
    const body = await jsonBody(get);
    const providerGroup = body.tree.groups.find((g: any) => g.groupId === 'provider');
    // v0.0.71 D3 嵌套：拍平 points[].impls[] 后查 impl（旧 extImpls 已删）
    const flat = flattenImpls<any>([providerGroup]);
    const impl = flat.find((e: any) => e.implId === 'anthropic_compatible');
    expect(impl.order).toBe(1);
  });

  it('v0.0.67 task3 PUT op=setOrder order 非数字 → 405（不再做 body 校验）', async () => {
    const r = await handleRequest(
      req('PUT', '/config/plugin', { op: 'setOrder', implId: 'anthropic_compatible', order: 'high' }),
      dataDir,
    );
    expect(r.status).toBe(405);
  });
});
