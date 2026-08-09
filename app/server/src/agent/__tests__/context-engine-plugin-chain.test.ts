/**
 * ContextEngine + rocky_context plugin 三链接线单测（v0.0.13 S1a/T4）
 * 参考: specs/tech/agent/context_and_memory/[P0]context_engine.md §3.5（ContextEngine 如何调框架）
 *       states/v0.0.13/task.json T4 acceptance（链跑通 + 替 systemPrompt + reminder 注入）
 *
 * 端到端（经 builtin-loader 加载真实 rocky_context plugin）：
 *   - 6 context EP 注册（inventory 含 context group）
 *   - ingest handler 链跑通：query_truncate 截断 + system_reminder_injector 注入
 *   - system_prompt builder：assemble 用构建的 system 替 config.systemPrompt
 *   - system_reminder provider 链跑通（env/time/workspace 贡献 reminder）
 *
 * 真实落盘：fs engine + 临时 DATA_DIR。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-context-chain-'));
  // 注册内置 EP + 加载 rocky_context plugin
  const registry = new Registry();
  for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
  // 不直接用 app/plugins/builtins（绝对路径 resolve）；指向源码目录
  const realBuiltins = join(__dirname, '../../../../plugins/builtins');
  await new BuiltinLoader(realBuiltins).loadAll(registry);
  // 验证 loader 找到 rocky_context（间接：registry.getByPoint('context_ingest_handler') 非空）
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

/** 造 session config（带 mock client + 可选 tools/cwd） */
function mkConfig(overrides: {
  sessionId?: string;
  tools?: unknown[];
  workdir?: string;
  contextWindow?: number;
  systemPrompt?: string;
} = {}): SessionConfig {
  return {
    sessionId: overrides.sessionId ?? ulid(),
    systemPrompt: overrides.systemPrompt ?? 'ORIGINAL-PROMPT',
    client: {
      contextWindow: overrides.contextWindow ?? 100000,
    } as unknown as LlmClient,
    modelId: 'test-model',
    tools: overrides.tools,
    workdir: overrides.workdir,
  };
}

describe('rocky_context plugin builtin-loader 登记', () => {
  it('6 context EP 注册（v0.0.66 +session_store EP = 7 context group EP）', () => {
    // 经 pluginManager 取各 point 的 active impl（registry 已含 EP）
    // [v0.0.40 D1=B] ingest 3→4（+buffer_sink）
    // [v0.0.49 D15] ingest 4→5（+store_sink）
    // [v0.0.66 §2.4] ingest 5→4（-buffer_sink，已删）
    // [v0.0.126] ingest 4→5（+search_indexing，history_search 索引写入）
    const handlers = pluginManager.getExtensionImpls(
      BUILTIN_EXTENSION_POINTS.find((e) => e.id === 'context_ingest_handler')!,
    );
    expect(handlers.length).toBe(5);
  });

  it('impl 登记（ingest 5 + prompt_mapper 12 + prompt_reducer 3 + reminder 8）= 28', () => {
    // v0.0.164 起 prompt_mapper 10→11（+memory_squad，v0.0.205 改名 memory_group）；
    // v0.0.232 11→12（+agent_profile）；v0.0.237 reminder 11→8（摘 squad_charter/task/squad_board）；
    // v0.0.240 reminder 8→9（+squad_task）；v0.0.273 reminder 9→8（reachable_agents + squad_team_status → squad_agents_status 统一）.
    const counts = {
      'context_ingest_handler': 5,
      'system_prompt_mapper': 12,
      'system_prompt_reducer': 3,
      'system_reminder': 8,
    };
    for (const [pointId, expected] of Object.entries(counts)) {
      const ep = BUILTIN_EXTENSION_POINTS.find((e) => e.id === pointId)!;
      const impls = pluginManager.getExtensionImpls(ep);
      expect(impls.length, `${pointId} 应有 ${expected} impl`).toBe(expected);
    }
  });
});

describe('ContextEngine ingest handler 链', () => {
  it('query_truncate 链生效：长 user query 被截断后落库', async () => {
    const cfg = mkConfig();
    const mid = ulid();
    const longText = 'a'.repeat(10000); // > 8000 默认阈值
    const msg: MessageInput = {
      id: mid,
      sessionId: cfg.sessionId,
      role: 'user',
      content: [{ type: 'text', text: longText }],
    };
    await engine.ingest(cfg, [msg]);
    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    expect(page.items).toHaveLength(1);
    const stored = page.items[0]!;
    const text = (stored.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(longText.length);
    expect(text).toContain('[query truncated');
    expect(stored.metadata?.rawRef).toBe(`raw:${mid}`);
  });

  it('system_reminder_injector 链生效：末尾 user message 追加 reminder block', async () => {
    const cfg = mkConfig({ workdir: tmpRoot });
    const msg: MessageInput = {
      id: ulid(),
      sessionId: cfg.sessionId,
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    await engine.ingest(cfg, [msg]);
    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    const stored = page.items[0]!;
    // reminder 链至少有 env/time 贡献（workspace 也有 workdir）→ reminder block 追加
    expect(stored.content.length).toBeGreaterThan(1);
    const reminderBlock = stored.content[stored.content.length - 1] as {
      type: string;
      text: string;
    };
    expect(reminderBlock.text).toContain('[system_reminder]');
    expect(reminderBlock.text).toMatch(/\d{4}-\d{2}-\d{2}/); // time
    // [v0.0.50] 消息级 metadata.isSystemReminder 已废止；块级 TextBlock.isSystemReminder 唯一权威
    expect(stored.metadata?.isSystemReminder).toBeUndefined();
    expect((reminderBlock as { isSystemReminder?: boolean }).isSystemReminder).toBe(true);
  });

  it('空链降级（pluginManager=null）→ 直接 append', async () => {
    const fallbackEngine = new ContextEngine({ store, pluginManager: null });
    const cfg = mkConfig();
    const msg: MessageInput = {
      id: ulid(),
      sessionId: cfg.sessionId,
      role: 'user',
      content: [{ type: 'text', text: 'plain' }],
    };
    await fallbackEngine.ingest(cfg, [msg]);
    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    expect(page.items[0]!.content).toHaveLength(1); // 无 reminder 注入
    expect((page.items[0]!.content[0] as { text: string }).text).toBe('plain');
  });
});

describe('ContextEngine assemble system_prompt 构建', () => {
  it('assemble 用 mapper/reducer 构建的 system 替换 config.systemPrompt', async () => {
    // 创建 session 先 ingest 一条 user msg（让 assemble 有数据）
    const cfg = mkConfig({
      systemPrompt: 'SHOULD-NOT-APPEAR',
      workdir: tmpRoot,
    });
    await store.createSession({ id: cfg.sessionId });
    writeFileSync(join(tmpRoot, 'AGENTS.md'), 'PROJECT-CONTEXT-MARKER');
    const msg: MessageInput = {
      id: ulid(),
      sessionId: cfg.sessionId,
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    };
    await engine.ingest(cfg, [msg]);

    const snap = await engine.assemble(cfg);
    expect(snap.system.content[0]).toHaveProperty('type', 'text');
    const sysText = (snap.system.content[0] as { text: string }).text;
    // 不含原 systemPrompt
    expect(sysText).not.toContain('SHOULD-NOT-APPEAR');
    // 含 identity（Rocky）+ rules + context_files（PROJECT-CONTEXT-MARKER）
    expect(sysText).toMatch(/Rocky/i);
    expect(sysText).toContain('PROJECT-CONTEXT-MARKER');
  });

  it('无 pluginManager → fallback config.systemPrompt（v0.0.8 行为）', async () => {
    const fb = new ContextEngine({ store, pluginManager: null });
    const cfg = mkConfig({ systemPrompt: 'FALLBACK-PROMPT' });
    await store.createSession({ id: cfg.sessionId });
    const msg: MessageInput = {
      id: ulid(),
      sessionId: cfg.sessionId,
      role: 'user',
      content: [{ type: 'text', text: 'x' }],
    };
    await fb.ingest(cfg, [msg]);
    const snap = await fb.assemble(cfg);
    expect((snap.system.content[0] as { text: string }).text).toBe('FALLBACK-PROMPT');
  });
});
