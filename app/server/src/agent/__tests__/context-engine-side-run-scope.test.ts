/**
 * ContextEngine forked scope 集成单测（v0.0.40 T5 D1=B；v0.0.66 §2.3/§2.6 重写；
 * v0.0.67 配置代码化：forked 配置改读 scopes/forked.json，删 ensureForkedScope）
 * 参考: reqs/[working] v0.0.67.plugin_config_refactor/design.md §2.1（配置代码化）+ §2.4（删流氓代码）
 *       specs/tech/agent/context/[P0]context_engine.md §3.6（源/汇可注入 + scope 驱动）
 *
 * 端到端（real rocky_context plugin + forked.json 代码声明 + real SessionStore + ContextEngine）：
 *   - ingest(scopeId='summary')：store_sink 写 in_memory_session_store（EP-selected）；
 *     持久 store transcript **绝不增长**
 *   - assemble(scopeId='summary', prevSnapshot)：transcript_reader 从 in_memory store 读增量；
 *     base_builder append 分支：[...prevSnapshot.messages, ...新增] = 父全量 + 增量；
 *     summary=null（in_memory getSummary 恒 null）→ version 不变 → 永远 append
 *   - forked 不写持久 session meta（updateContextWindowUsage 经 in_memory store no-op）
 *
 * 关键不变量（spec §3.6 + design §1）：forked 绝不写持久 store transcript、绝不读持久 store summary。
 * 零 isForked：default/forked 同一套主干逻辑，差异靠 store EP impl 切换。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../plugin/registry';
import { PluginManager } from '../../plugin/plugin-manager';
import { BuiltinLoader } from '../../plugin/builtin-loader';
import { BUILTIN_EXTENSION_POINTS } from '../../plugin/extension-point';
import { PluginConfigService } from '../../plugin/plugin-config-service';
import { ScopeConfigLoader } from '../../plugin/scope-config-loader';
import { ScopeConfigValidator } from '../../plugin/scope-config-validator';
import { LoadedScopeConfigProvider } from '../../plugin/scope-config-provider';
import { GroupMetaLoader } from '../../plugin/group-meta-loader';
import { LoadedGroupMetaProvider } from '../../plugin/group-meta-provider';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import { ContextEngine } from '../context-engine';
import { setSessionStoreEpDelegate } from '../session-store-ep-delegate';
import type { ContextSnapshot, SessionConfig } from '../context-types';
import type { Message, MessageInput } from '../../message/types';
import type { LlmClient } from '../../llm/client';

let tmpRoot: string;
let store: SessionStore;
let pluginManager: PluginManager;
let engine: ContextEngine;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-ce-forked-'));
  const registry = new Registry();
  for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
  const realBuiltins = join(__dirname, '../../../../plugins/builtins');
  await new BuiltinLoader(realBuiltins).loadAll(registry);

  // [v0.0.67] 加载真实 scopes/default.json + forked.json + test.json（test env fixture EP 未注册，
  //   非 test env 过滤 test scope；本测试不依赖 APP_ENV，但加载全量后再过滤 test 保持简洁）
  // [v0.0.71 D6] Validator 加必填 groups（验 registry ↔ groups.json 双向一致），加载真实 groups.json
  const realScopes = join(__dirname, '../../../../plugins/scopes');
  const realGroups = join(__dirname, '../../../../plugins/groups.json');
  const groups = new GroupMetaLoader(realGroups).load().groups;
  const scopeConfigs = new ScopeConfigLoader(realScopes)
    .loadAll()
    .filter((c) => c.scopeId !== 'test'); // 非 test env：剔除 test scope（避免 validator 失败）
  new ScopeConfigValidator({ registry, groups }).validateAll(scopeConfigs);
  const scopeConfigProvider = new LoadedScopeConfigProvider(scopeConfigs);

  const pluginConfigService = new PluginConfigService(registry, {
    root: tmpRoot,
    scopeConfigs: scopeConfigProvider,
    // v0.0.71 D1：注入 groupMeta（同 groups.json 加载源），inventory-builder JOIN group 用
    groupMeta: new LoadedGroupMetaProvider(groups),
  });
  pluginManager = new PluginManager({ registry, scopeConfigs: scopeConfigProvider });
  // v0.0.67：pluginConfigService 仅为后续可能的写 op 调用保留（本测试不写），不再调 ensureForkedScope
  void pluginConfigService;

  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  // [v0.0.66 §2.3] 注入持久 store 到 persistent_session_store EP impl 的 delegate holder。
  //   default scope 的 assemble/ingest 经 resolveStore('default') 拿 EP impl，委托 delegate 读写持久 store。
  setSessionStoreEpDelegate(store);
  engine = new ContextEngine({ store, pluginManager });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造 session config（带 mock client） */
function mkConfig(sessionId?: string): SessionConfig {
  return {
    sessionId: sessionId ?? ulid(),
    systemPrompt: 'ORIGINAL-PROMPT',
    client: { contextWindow: 100000 } as unknown as LlmClient,
    modelId: 'test-model',
  };
}

/** 造假 prevSnapshot（父全量 messages，供 base_builder append 复用） */
function mkPrevSnapshot(sid: string, messages: Message[]): ContextSnapshot {
  return {
    system: {
      id: 'system', sessionId: sid, role: 'system',
      content: [{ type: 'text', text: 'PARENT-SYS' }],
    },
    messages,
    inputCharCount: 0,
    contextWindowUsage: {
      systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0,
      maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 100000,
    },
    summary: null,
    tools: [],
  };
}

describe('[v0.0.66 §2.6] ContextEngine.ingest forked scope — 写 in_memory store 不碰持久 store', () => {
  it("scopeId='summary' → in_memory store 写入（getMessages 能读到），持久 store transcript 绝不增长", async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    const msg: MessageInput = {
      id: ulid(),
      sessionId: cfg.sessionId,
      role: 'user',
      content: [{ type: 'text', text: 'forked msg' }],
    };
    await engine.ingest(cfg, [msg], 'summary', false);

    // 持久 store transcript **绝不增长**（forked 写 in_memory_session_store，不写持久 store）
    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    expect(page.items).toHaveLength(0);

    // in_memory store 写入：经 resolveStore('summary') 读 in_memory_session_store 能拿到
    const forkedStore = (engine as unknown as { resolveStore: (s: string) => unknown }).resolveStore('summary') as {
      getMessages: (sid: string, range?: { limit?: number }) => Promise<{ items: Message[] }>;
    };
    const inMemPage = await forkedStore.getMessages(cfg.sessionId, { limit: 100 });
    expect(inMemPage.items).toHaveLength(1);
    expect(inMemPage.items[0]!.role).toBe('user');
  });

  it("scopeId='default'（缺省）→ 持久 store 写入（行为不变，回归保护）", async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    const msg: MessageInput = {
      id: ulid(),
      sessionId: cfg.sessionId,
      role: 'user',
      content: [{ type: 'text', text: 'default msg' }],
    };
    await engine.ingest(cfg, [msg]); // 缺省 scopeId='default'

    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.role).toBe('user');
  });

  it('forked 多轮 ingest → in_memory store 逐次追加（append-only）', async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });

    const msg1: MessageInput = { id: ulid(), sessionId: cfg.sessionId, role: 'user', content: [{ type: 'text', text: 'q1' }] };
    const msg2: MessageInput = { id: ulid(), sessionId: cfg.sessionId, role: 'assistant', content: [{ type: 'text', text: 'a1' }] };
    await engine.ingest(cfg, [msg1], 'summary', false);
    await engine.ingest(cfg, [msg2], 'summary', false);

    // in_memory store 累积 2 条（append-only）
    const forkedStore = (engine as unknown as { resolveStore: (s: string) => unknown }).resolveStore('summary') as {
      getMessages: (sid: string, range?: { limit?: number }) => Promise<{ items: Message[] }>;
    };
    const inMemPage = await forkedStore.getMessages(cfg.sessionId, { limit: 100 });
    expect(inMemPage.items).toHaveLength(2);
    // 持久 store 仍为空
    const page = await store.getMessages(cfg.sessionId, { limit: 100 });
    expect(page.items).toHaveLength(0);
  });
});

describe('[v0.0.66 §2.6] ContextEngine.assemble forked scope — 复用 prevSnapshot + 追加 in_memory 增量', () => {
  it("scopeId='summary' + prevSnapshot（父全量）+ in_memory 增量 → snapshot.messages = 父全量 + 增量", async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    // 父 prevSnapshot：messages 含 1 条父 assistant（用 assistant 而非 user，
    //   避免与 forked 新增的 user 同 role 被 role_merge 合并——隔离 side_run_builder prepend
    //   路径的验证目标，role_merge 行为由专门 test 覆盖）
    const parentMsg: Message = {
      id: 'parent-a1', sessionId: cfg.sessionId, role: 'assistant',
      content: [{ type: 'text', text: 'parent-answer' }],
    };
    const prev = mkPrevSnapshot(cfg.sessionId, [parentMsg]);

    // forked ingest 1 条增量到 in_memory store
    const newMsg: MessageInput = {
      id: 'forked-u1', sessionId: cfg.sessionId, role: 'user',
      content: [{ type: 'text', text: 'forked-task' }],
    };
    await engine.ingest(cfg, [newMsg], 'summary', false);

    // assemble('summary', prevSnapshot=prev) → side_run_builder：[...prev.messages, ...新增]
    const snap = await engine.assemble(cfg, 'summary', prev);

    const pickedIds = snap.messages.map((m) => m.id);
    // 父全量 1 条 + 增量 1 条 = 2 条（system 不在 messages 里，由 snapshot.system 独立承载）
    expect(pickedIds).toEqual(['parent-a1', 'forked-u1']);
    // system 在 snapshot.system（非 messages[0]）
    expect(snap.system.id).toBe('system');
    // summary 恒 null（in_memory store getSummary 返 null → version 不变 → 永远 append）
    expect(snap.summary).toBeNull();
  });

  it("forked scope assemble 输出未合并（role_merge 在 getCleanSnapshot 才合并）", async () => {
    // role_merge 迁到 context_clean_view_reducer EP（assemble 不再跑清理）；
    //   side_run_builder 产出 [parent-u1, forked-u1]（未合并），role_merge 在 getCleanSnapshot 才合并。
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    // 父 prevSnapshot：messages 含 1 条父 user（与新增量同 role → 触发 role_merge）
    const parentMsg: Message = {
      id: 'parent-u1', sessionId: cfg.sessionId, role: 'user',
      content: [{ type: 'text', text: 'parent-question' }],
    };
    const prev = mkPrevSnapshot(cfg.sessionId, [parentMsg]);
    const newMsg: MessageInput = {
      id: 'forked-u1', sessionId: cfg.sessionId, role: 'user',
      content: [{ type: 'text', text: 'forked-task' }],
    };
    await engine.ingest(cfg, [newMsg], 'summary', false);

    const snap = await engine.assemble(cfg, 'summary', prev);
    const pickedIds = snap.messages.map((m) => m.id);
    // assemble 输出未合并（role_merge 已迁 clean_view EP，不在 assemble 链里跑）
    expect(pickedIds).toEqual(['parent-u1', 'forked-u1']);

    // 验清理链：getCleanSnapshot 跑 role_merge 后合并为 ['parent-u1']（content 含两段）
    const cleaned = await engine.getCleanSnapshot(snap, 'summary');
    const cleanedIds = cleaned.messages.map((m) => m.id);
    expect(cleanedIds).toEqual(['parent-u1']);
    const merged = cleaned.messages[0]!;
    const texts = merged.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text);
    expect(texts).toEqual(['parent-question', 'forked-task']);
  });

  it("scopeId='summary' 不写持久 session meta（contextWindowUsage 不污染主对话）", async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    const prev = mkPrevSnapshot(cfg.sessionId, []);
    await engine.ingest(cfg, [{ id: 'f1', sessionId: cfg.sessionId, role: 'user', content: [{ type: 'text', text: 'q' }] }], 'summary', false);

    await engine.assemble(cfg, 'summary', prev);

    // 持久 store 的 session meta 不被 forked assemble 写入（forked updateContextWindowUsage 走 in_memory store no-op）
    const session = await store.getSession(cfg.sessionId);
    const storedUsage = (session as { contextWindowUsage?: unknown }).contextWindowUsage;
    expect(storedUsage).toBeFalsy();
  });

  it("scopeId='default'（缺省）仍写持久 session meta（行为不变，回归保护）", async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    // 先 ingest 一条（default 写持久 store）
    const msg: MessageInput = { id: ulid(), sessionId: cfg.sessionId, role: 'user', content: [{ type: 'text', text: 'q' }] };
    await engine.ingest(cfg, [msg]);
    await engine.assemble(cfg); // default

    const session = await store.getSession(cfg.sessionId);
    const storedUsage = (session as { contextWindowUsage?: { tokenLimit?: number } }).contextWindowUsage;
    expect(storedUsage).toBeDefined();
    expect(storedUsage?.tokenLimit).toBe(100000);
  });

  it("scopeId='summary' 无 prevSnapshot + 空 in_memory store → rebuild 路径产出空 messages（不 crash）", async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    // 不 ingest 任何增量；不传 prevSnapshot（null）→ rebuild 路径（prev 空 → rebuild）
    const snap = await engine.assemble(cfg, 'summary', null);
    expect(snap).toBeDefined();
    // rebuild 无 summary → messages = [...transcript（空）] = []
    expect(snap.messages).toEqual([]);
    // system 仍由 snapshot.system 独立承载（buildSystemPrompt 调用产出）
    expect(snap.system.id).toBe('system');
  });
});

describe('[v0.0.83.forked_per_run_isolation] ContextEngine forked per-run 隔离（real EP + in_memory）', () => {
  // 第一性原则：每个 forked run 是独立运行节点，须有独立 buffer 区域。
  // 集成层证明（ContextEngine → resolveStore → in_memory_session_store EP impl + transcript_reader/store_sink
  //   全程真链路）：两 sibling（summary + memory_extract）同 sid 不同 runId → buffer 物理隔离。

  it('两 sibling forked run（同 sid，不同 runId）→ assemble 各自只见自己的增量（零交叉）', async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });

    // summary sibling run（runId-A）ingest 增量
    await engine.ingest(
      cfg,
      [{ id: 'sum-u1', sessionId: cfg.sessionId, role: 'user', content: [{ type: 'text', text: 'SUMMARY_DIRECTIVE' }] }],
      'summary', false, { runId: 'run-sum-ce-1' },
    );
    // memory_extract sibling run（runId-B，同 sid）ingest 增量
    await engine.ingest(
      cfg,
      [{ id: 'ext-u1', sessionId: cfg.sessionId, role: 'user', content: [{ type: 'text', text: 'EXTRACT_DIRECTIVE' }] }],
      'summary', false, { runId: 'run-ext-ce-1' },
    );

    // 各自 assemble（prevSnapshot 空 → messages = 该 runId 桶的增量）：零交叉
    const sumSnap = await engine.assemble(cfg, 'summary', mkPrevSnapshot(cfg.sessionId, []), { runId: 'run-sum-ce-1' });
    const extSnap = await engine.assemble(cfg, 'summary', mkPrevSnapshot(cfg.sessionId, []), { runId: 'run-ext-ce-1' });

    expect(sumSnap.messages.map((m) => m.id)).toEqual(['sum-u1']);
    expect(extSnap.messages.map((m) => m.id)).toEqual(['ext-u1']);
    // 负向：summary 桶绝不含 extract 指令（修前的 bug——三套矛盾指令同桶）
    expect(JSON.stringify(sumSnap.messages)).not.toContain('EXTRACT');
    expect(JSON.stringify(extSnap.messages)).not.toContain('SUMMARY');
  });

  it('clearScopeSession(scope, sid, {runId}) 只释放该 run 的 buffer（sibling 不受影响）', async () => {
    const cfg = mkConfig();
    await store.createSession({ id: cfg.sessionId });
    await engine.ingest(cfg, [{ id: 'sum-u2', sessionId: cfg.sessionId, role: 'user', content: [{ type: 'text', text: 's' }] }], 'summary', false, { runId: 'run-sum-ce-2' });
    await engine.ingest(cfg, [{ id: 'ext-u2', sessionId: cfg.sessionId, role: 'user', content: [{ type: 'text', text: 'e' }] }], 'summary', false, { runId: 'run-ext-ce-2' });

    // 回收 summary run 的桶
    await engine.clearScopeSession('summary', cfg.sessionId, { runId: 'run-sum-ce-2' });

    // summary 桶已空（assemble 无增量 → messages 空）
    const sumSnap = await engine.assemble(cfg, 'summary', mkPrevSnapshot(cfg.sessionId, []), { runId: 'run-sum-ce-2' });
    expect(sumSnap.messages).toEqual([]);
    // extract sibling 桶不受影响（回收不误伤 sibling——per-run 隔离回收的关键）
    const extSnap = await engine.assemble(cfg, 'summary', mkPrevSnapshot(cfg.sessionId, []), { runId: 'run-ext-ce-2' });
    expect(extSnap.messages.map((m) => m.id)).toEqual(['ext-u2']);
  });
});
