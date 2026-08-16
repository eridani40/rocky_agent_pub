/**
 * assemble 增量构建（P0-1 prevSnapshot）+ ratio 动态化（P2-3）
 * 参考: reqs/v0.0.49.forked_agent/req.md「并进 v0.0.52」章节
 *       reqs/v0.0.52.context_engine_fix/research.md §3 P0-1/P2-3
 *       states/v0.0.49.forked_agent/verify/test-plan.md「task4 并进」UT 范围
 *
 * 本文件覆盖端到端（经 ContextEngine.assemble 真实插件链）：
 *   - P0-1 end-to-end：prevSnapshot 透传到 base_builder，id 序列末尾追加（append 分支激活）
 *   - P2-3：ratio=0.5 vs ratio=1.0 同 tokenCap → 0.5 取得更多 head message（[v0.0.185] char×ratio 累加）
 *
 * [v0.0.66 §2.6] forked 回归 UT 已迁至 context-engine-forked-scope.test.ts（新 in_memory_session_store 行为）。
 *
 * 注：P0-1 的 message 引用相等性断言在 base_builder 直接单测层做
 *   （app/plugins/builtins/rocky_context/__tests__/assemble-reducers.test.ts），
 *   因 end-to-end 经 orphan_tool_call/snip_handler reducer 会重建 system msg 对象（引用不等是预期）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../plugin/registry';
import { PluginManager } from '../../plugin/plugin-manager';
import { BuiltinLoader } from '../../plugin/builtin-loader';
import { BUILTIN_EXTENSION_POINTS } from '../../plugin/extension-point';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import { ContextEngine } from '../context-engine';
import { setSessionStoreEpDelegate } from '../session-store-ep-delegate';
import { LoadedScopeConfigProvider } from '../../plugin/scope-config-provider';
import type { SessionConfig, ContextSnapshot } from '../context-types';
import type { MessageInput } from '../../message/types';
import type { LlmClient } from '../../llm/client';

let tmpRoot: string;
let store: SessionStore;
let pluginManager: PluginManager;
let engine: ContextEngine;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-asm-prev-ratio-'));
  const registry = new Registry();
  for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
  const realBuiltins = join(__dirname, '../../../../plugins/builtins');
  await new BuiltinLoader(realBuiltins).loadAll(registry);
  // v0.0.179：加载真实 default.yaml（impl 列表模型，membership = active）
  const realScopes = join(__dirname, '../../../../plugins/scopes');
  const { ScopeConfigLoader } = await import('../../plugin/scope-config-loader');
  const scopeConfigs = new ScopeConfigLoader(realScopes).loadAll();
  const provider = new LoadedScopeConfigProvider(scopeConfigs);
  pluginManager = new PluginManager({ registry, scopeConfigs: provider });

  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  // [v0.0.66 §2.3] 注入持久 store 到 persistent_session_store EP impl 的 delegate holder
  setSessionStoreEpDelegate(store);
  engine = new ContextEngine({ store, pluginManager });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造 SessionConfig（小 contextWindow 让 head/tail 预算敏感于 ratio） */
function mkConfig(sid?: string): SessionConfig {
  return {
    sessionId: sid ?? ulid(),
    systemPrompt: 'ORIGINAL',
    client: { contextWindow: 10000 } as unknown as LlmClient,
    modelId: 'm',
    providerId: 'p-m',
  };
}

function userMsg(sid: string, text: string, id?: string): MessageInput {
  return {
    id: id ?? ulid(),
    sessionId: sid,
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

/** 生成 n 字符的填充文本（让 message char 数可控） */
function filler(n: number): string {
  return 'x'.repeat(n);
}

// ============================================================
// P0-1 end-to-end：ContextEngine.assemble rebuild 不变量（base_builder 永远 rebuild）
// ============================================================
describe('P0-1 ContextEngine.assemble rebuild 不变量（base_builder 永远 rebuild）', () => {
  it('同输入（summary version + transcript 不变）→ 同输出（id 序列相等）', async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    // user/assistant 交替（避免 role_merge 合并相邻同 role）
    const ids = Array.from({ length: 3 }, () => ulid());
    const msgs: MessageInput[] = ids.map((id, i) => ({
      id, sessionId: cfg.sessionId,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: [{ type: 'text', text: `msg-${i}` }],
    }));
    await engine.ingest(cfg, msgs);
    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    const sortedIds = page.items.map((m) => m.id);
    await store.setSummary(cfg.sessionId, { content: 'SUMMARY-V1', summaryUpTo: sortedIds[0]! });

    // base_builder 是确定性纯函数 f(summary, transcript)：
    //   同 summary version + 同 transcript → 同输出（不管 prevSnapshot 传什么）
    //   prevSnapshot 不再读（INVARIANT：相同输入相同输出）
    const snap1 = await engine.assemble(cfg, 'default', null);
    const snap2 = await engine.assemble(cfg, 'default', snap1);

    // id 序列完全相等（rebuild 不变量——不再有 append 分支让 snap2 末尾追加）
    const snap1Ids = snap1.messages.map((m) => m.id);
    const snap2Ids = snap2.messages.map((m) => m.id);
    expect(snap2Ids).toEqual(snap1Ids);
  });

  it('transcript 新增 m4 → rebuild 的 recent 自动反映 m4（无需 append 分支）', async () => {
    // 用大 contextWindow 让 assemble budget 能容纳 recent（estimatedOutput=20000，需 tokenLimit > 20000）
    const cfg: SessionConfig = {
      sessionId: ulid(),
      systemPrompt: 'ORIGINAL',
      client: { contextWindow: 100000 } as unknown as LlmClient,
      modelId: 'm',
      providerId: 'p-m',
    };
    await store.createSession({ id: cfg.sessionId });
    const ids = Array.from({ length: 3 }, () => ulid());
    const msgs: MessageInput[] = ids.map((id, i) => ({
      id, sessionId: cfg.sessionId,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: [{ type: 'text', text: `msg-${i}` }],
    }));
    await engine.ingest(cfg, msgs);
    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    const sortedIds = page.items.map((m) => m.id);
    await store.setSummary(cfg.sessionId, { content: 'SUMMARY-V1', summaryUpTo: sortedIds[0]! });

    const snap1 = await engine.assemble(cfg, 'default', null);

    // ingest m4（assistant，与 m3 不同 role 避免合并）
    const m4Id = ulid();
    await engine.ingest(cfg, [{
      id: m4Id, sessionId: cfg.sessionId, role: 'assistant',
      content: [{ type: 'text', text: 'msg-3-new' }],
    }]);

    // 第二次 assemble（prevSnapshot 传不传都一样——rebuild 只读 transcript）
    const snap2 = await engine.assemble(cfg, 'default', null);

    // rebuild 路径：summary 在前 + recent 在后（recent = summaryUpTo 之后所有）
    //   m4 是 assistant（在 summaryUpTo 之后）→ 出现在 recent 段（非末尾的 summary:1）
    const snap2Ids = snap2.messages.map((m) => m.id);
    expect(snap2Ids).toContain(m4Id);
    // snap2 比 snap1 多 1 条（m4 进 recent）
    expect(snap2.messages.length).toBeGreaterThan(snap1.messages.length);
  });
});

// ============================================================
// P2-3：base_builder ratio 动态化（head/tail char×ratio 累加，[v0.0.185] tokenCap 算法）
// ============================================================
describe('P2-3 base_builder ratio 动态化（同 tokenCap，ratio 小 → head 取得更多）', () => {
  it('ratio=0.5 比 ratio=1.0 取得更多 head message（char×ratio 累加同 cap 放行更多）', async () => {
    // 大 contextWindow（100000）避免 assemble budget 截 tail 干扰 head 段计数
    const cfg: SessionConfig = {
      sessionId: ulid(),
      systemPrompt: 'ORIGINAL',
      client: { contextWindow: 100000 } as unknown as LlmClient,
      modelId: 'm',
      providerId: 'p-m',
    };
    await store.createSession({ id: cfg.sessionId });
    // 10 条 head 候选（每条 1500 字符文本），summaryUpTo 设在末尾 → 全部成 head 候选
    // 注：ingest 会给末条 user message 注入 reminder（+~126 char），尺寸选取让 cap 边界有余量
    const headMsgs: MessageInput[] = Array.from({ length: 10 }, () =>
      userMsg(cfg.sessionId, filler(1500), ulid()),
    );
    await engine.ingest(cfg, headMsgs);
    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    const sortedIds = page.items.map((m) => m.id);
    await store.setSummary(cfg.sessionId, {
      content: 'S', summaryUpTo: sortedIds[sortedIds.length - 1]!,
    });

    // [v0.0.185] tokenCap=10000（默认）：ratio=1.0 → 1500×1.0=1500/msg
    //   累积：1500→…→9000(≤cap)→+1500=10500(>cap 停) → head=6
    const spy1 = vi.spyOn(store, 'getRatio').mockResolvedValue(1.0);
    const snapR1 = await engine.assemble(cfg, "default", null);
    spy1.mockRestore();
    const headCountR1 = countBlocks(snapR1, 'head');

    // ratio=0.5：1500×0.5=750/msg → 10 条≈7500(≤cap，末条含 reminder 也不超) → head=10（候选全集）
    const spy2 = vi.spyOn(store, 'getRatio').mockResolvedValue(0.5);
    const snapR05 = await engine.assemble(cfg, "default", null);
    spy2.mockRestore();
    const headCountR05 = countBlocks(snapR05, 'head');

    // 核心断言：ratio=0.5 取得更多 head（token 估算更小 → 同 cap 放更多）
    expect(headCountR05).toBeGreaterThan(headCountR1);
    expect(headCountR1).toBe(6); // cap 累加停止
    expect(headCountR05).toBe(10); // 候选全取
  });
});

/** [v0.0.81] 数 summary text block 中指定段（head/tail）的 [msgid|role] 行数（替代旧 [head]/[tail] 多 block 计数） */
function countBlocks(snap: ContextSnapshot, tag: 'head' | 'tail'): number {
  const sumMsg = snap.messages.find((m) => m.id.startsWith('summary:'));
  if (!sumMsg) return 0;
  const textBlock = sumMsg.content[0] as { text?: string } | undefined;
  if (!textBlock || typeof textBlock.text !== 'string') return 0;
  const startMarker = `--- ${tag}`;
  const lines = textBlock.text.split('\n');
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    if (line.startsWith(startMarker)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (line.startsWith('--- ')) break; // 下一段
      if (/^\[[^\]]+\|\w+\]/.test(line)) count++;
    }
  }
  return count;
}

// [v0.0.66 §2.6] forked 回归 describe 块已删——旧 forked 行为（buffer_sink/buffer_reader/
// append_passthrough 原样返回 buffer）已随 impl 删除退役。新 forked 行为（in_memory_session_store
// + base_builder append 复用父 prevSnapshot）由 context-engine-forked-scope.test.ts 覆盖。
