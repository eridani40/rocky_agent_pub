/**
 * ContextEngine assemble mapper+reducer 链接线单测（v0.0.13 S1b/T5）
 * 参考: specs/tech/agent/context_and_memory/[P0]context_assemble_detail.md §1/§2/§3
 *       states/v0.0.13/task.json T5 acceptance（链替 head3+tail3 + 增量 + fallback）
 *
 * 端到端（经 builtin-loader 加载真实 rocky_context plugin 31 impl）：
 *   - assemble 跑 mapper(4) + reducer(5) 链产出 picked（含 system msg + summary msg + recent）
 *   - 无 summary → [system] + 全 transcript
 *   - 有 summary → base_builder head/tail + recent（替 v0.0.8 head3+tail3）
 *   - inventory：31 impl 登记（context_assemble_mapper 4 + reducer 5）
 *     [v0.0.98] reducer 数 +think_remove（5→6），inventory 见下方用例实算
 *   - fallback：pluginManager=null → v0.0.8 head3+tail3（保既有 UT）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import type { SessionConfig } from '../context-types';
import type { MessageInput } from '../../message/types';
import type { LlmClient } from '../../llm/client';

let tmpRoot: string;
let store: SessionStore;
let pluginManager: PluginManager;
let engine: ContextEngine;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-asm-pipeline-'));
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

function mkConfig(sid?: string): SessionConfig {
  return {
    sessionId: sid ?? ulid(),
    systemPrompt: 'ORIGINAL',
    client: { contextWindow: 100000 } as unknown as LlmClient,
    modelId: 'm',
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

describe('rocky_context plugin impl 登记', () => {
  it('context_assemble_mapper 2 impl + context_assemble_reducer 2 impl + context_clean_view_reducer 8 impl', () => {
    const mappers = pluginManager.getExtensionImpls(
      BUILTIN_EXTENSION_POINTS.find((e) => e.id === 'context_assemble_mapper')!,
    );
    const reducers = pluginManager.getExtensionImpls(
      BUILTIN_EXTENSION_POINTS.find((e) => e.id === 'context_assemble_reducer')!,
    );
    const cleanReducers = pluginManager.getExtensionImpls(
      BUILTIN_EXTENSION_POINTS.find((e) => e.id === 'context_clean_view_reducer')!,
    );
    // v0.0.179：mapper 2；assemble_reducer default 仅激活 base_builder（side_run_builder 在 forked scope）
    // v0.0.207：clean_view 7 个清理 reducer（头插 dedup_tool_result）
    // v0.0.256：clean_view 8 个（第 4 位插 bubble_text_before_tool_call）
    expect(mappers).toHaveLength(2);
    expect(reducers).toHaveLength(1);
    expect(cleanReducers).toHaveLength(8);
  });

  it('全 impl inventory（ingest 5 + assemble_mapper 2 + assemble_reducer 1 + clean_view_reducer 8 + prompt_mapper 12 + prompt_reducer 3 + reminder 9 + session_store exclusive 选 1）= 41', () => {
    const counts = {
      context_ingest_handler: 5,
      context_assemble_mapper: 2,
      context_assemble_reducer: 1, // v0.0.179：default 仅 base_builder（side_run_builder forked scope）
      context_clean_view_reducer: 8, // v0.0.207 头插 dedup_tool_result；v0.0.256 第 4 位插 bubble_text_before_tool_call
      system_prompt_mapper: 12, // v0.0.232 +agent_profile
      system_prompt_reducer: 3,
      system_reminder: 9, // v0.0.237 摘 squad_charter/task/squad_board；v0.0.240 +squad_task
      session_store: 1, // exclusive EP：恰好 1 active
    };
    let total = 0;
    for (const [pointId, expected] of Object.entries(counts)) {
      const ep = BUILTIN_EXTENSION_POINTS.find((e) => e.id === pointId)!;
      const impls = pluginManager.getExtensionImpls(ep);
      expect(impls.length, `${pointId} 应有 ${expected} impl`).toBe(expected);
      total += expected;
    }
    // 总数：5+2+1+8+12+3+9+1 = 41
    expect(total).toBe(41);
  });
});

describe('ContextEngine assemble 链（替 v0.0.8 head3+tail3）', () => {
  it('无 summary → picked = 全 transcript（system 由 snapshot.system 独立承载，不在 messages）', async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    await engine.ingest(cfg, [userMsg(cfg.sessionId, 'hi')]);

    const snap = await engine.assemble(cfg);
    // [v0.0.66 §2.5] system 不在 messages 里（design §1.3：system 独立由 snapshot.system 承载）
    expect(snap.messages.length).toBeGreaterThanOrEqual(1);
    // messages 全是业务 message（无 id=system）
    const ids = snap.messages.map((m) => m.id);
    expect(ids).not.toContain('system');
    // system 在 snapshot.system（buildSystemPrompt 调用产出，含 identity Rocky）
    expect(snap.system.id).toBe('system');
    const sysText = (snap.system.content[0] as { text: string }).text;
    expect(sysText).toMatch(/Rocky/i);
    expect(sysText).not.toContain('ORIGINAL'); // 非原 config.systemPrompt
  });

  it('有 summary → base_builder rebuild：[summary msg] + recent（无 system msg）', async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    // ingest 8 条 assistant/user 交替（避免 role_merge 全合一条）。
    // [v0.0.81.compaction_bug] summary role 改 user → recent 首条必须是 assistant，
    //   否则 role_merge 会把 recent 首条 user 合并进 summary:1（自然行为，但本 case 测试链产出结构）。
    const ids = Array.from({ length: 8 }, () => ulid());
    const msgs: MessageInput[] = ids.map((id, i) => ({
      id,
      sessionId: cfg.sessionId,
      role: (i % 2 === 0 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: [{ type: 'text', text: `msg-${i}` }],
    }));
    await engine.ingest(cfg, msgs);
    // store 按 id（ULID 字典序=时间序）排序，读真实顺序取 summaryUpTo（第 4 条）
    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    const sortedIds = page.items.map((m) => m.id);
    const upToId = sortedIds[3]!; // head 候选 = sortedIds[0..3]，recent = sortedIds[4..7]
    await store.setSummary(cfg.sessionId, {
      content: 'COMPRESSED-HISTORY',
      summaryUpTo: upToId,
    });

    const snap = await engine.assemble(cfg);
    // [v0.0.66 §2.5] 链产出：summary msg + 4 recent（system 不在 messages，由 snapshot.system 独立）
    const pickedIds = snap.messages.map((m) => m.id);
    expect(pickedIds).not.toContain('system'); // system 不在 messages
    expect(pickedIds).toContain('summary:1');
    // recent = sortedIds[4..7]（assistant/user 交替，summary(user)→assistant(4) 不合并）
    expect(pickedIds).toContain(sortedIds[4]);
    expect(pickedIds).toContain(sortedIds[7]);
    // summary msg content 含 COMPRESSED-HISTORY
    const summaryMsg = snap.messages.find((m) => m.id === 'summary:1')!;
    const summaryText = (summaryMsg.content[0] as { text: string }).text;
    // [v0.0.81.compaction_bug] summary 是 1 个 text content block，3 段（preamble+head+tail）拼接，
    //   SUMMARY 正文嵌入 preamble 段，不再独占 1 个 block。toContain 校验内容存在。
    expect(summaryText).toContain('COMPRESSED-HISTORY');
    // [v0.0.81.compaction_bug] summary role = user（recap 作 user 上下文）
    expect(summaryMsg.role).toBe('user');
    // system 在 snapshot.system
    expect(snap.system.id).toBe('system');
  });

  it('链非 v0.0.8 head3+tail3（picked 全业务 message，system 由 snapshot.system 独立）', async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    await engine.ingest(cfg, [userMsg(cfg.sessionId, 'only-one')]);

    const snap = await engine.assemble(cfg);
    // v0.0.8 fallback：picked 全业务 message；链产出：picked 全业务 message（无 id=system）。
    // 区别在 system 来源——fallback: config.systemPrompt；链：buildSystemPrompt。
    const firstId = snap.messages[0]!.id;
    expect(firstId).not.toBe('system');
    expect(snap.messages[0]!.role).toBe('user');
    // 链产 system 在 snapshot.system（buildSystemPrompt 含 Rocky）
    expect(snap.system.id).toBe('system');
    expect((snap.system.content[0] as { text: string }).text).toMatch(/Rocky/i);
  });
});

describe('ContextEngine assemble fallback（pluginManager=null → v0.0.8 head3+tail3）', () => {
  it('pluginManager=null → picked 全业务 message（无 system msg 在 picked）', async () => {
    const fb = new ContextEngine({ store, pluginManager: null });
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    await fb.ingest(cfg, [userMsg(cfg.sessionId, 'plain')]);

    const snap = await fb.assemble(cfg);
    // fallback：picked 全是业务 message（无 id=system 的 msg 在 picked 里）
    const ids = snap.messages.map((m) => m.id);
    expect(ids).not.toContain('system');
    expect(snap.messages[0]!.role).toBe('user');
    // system 字段单独填
    expect(snap.system.id).toBe('system');
    expect((snap.system.content[0] as { text: string }).text).toBe('ORIGINAL');
  });

  it('pluginManager=null + 有 summary + >6 条 → head3+summaryMsg+tail3', async () => {
    const fb = new ContextEngine({ store, pluginManager: null });
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    const ids = Array.from({ length: 8 }, () => ulid());
    const msgs = ids.map((id, i) => userMsg(cfg.sessionId, `m-${i}`, id));
    await fb.ingest(cfg, msgs);
    // head3+tail3 fallback 依赖 store 顺序（ULID 字典序）
    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    const sortedIds = page.items.map((m) => m.id);
    await store.setSummary(cfg.sessionId, {
      content: 'SUMMARY',
      summaryUpTo: sortedIds[3] ?? null,
    });

    const snap = await fb.assemble(cfg);
    // head3 + summaryMsg + tail3 = 7 条
    expect(snap.messages).toHaveLength(7);
    expect(snap.messages[0]!.id).toBe(sortedIds[0]);
    expect(snap.messages[3]!.id).toBe('summary:1');
    expect(snap.messages[6]!.id).toBe(sortedIds[7]);
    // [v0.0.81.compaction_bug] summary role = user（不是 system）
    expect(snap.messages[3]!.role).toBe('user');
  });
});
