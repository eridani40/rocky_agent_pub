/**
 * buildSessionConfigFromDeps resolveTools 集成 UT（v0.0.48 Task 2）
 * 参考: specs/tech/agent/tools/[P0]tool_policy.md §4.1（config 层接线）+ §1.3（三层一致）
 *       specs/tech/version_logs/v0.0.48/change_log.md §3.2（session-config.ts 修改）
 *
 * 本文件聚焦 playground-rocky + subagent mainAllowedTools ∩ bound 路径（B1 playground squad
 * 泄漏修复 + subagent ∩ bound 修复的回归网）。studio leader/mate/squad 见 session-config-studio.test.ts。
 *
 * [v0.0.56 hotfix] kind 必传（pos 5）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { AppConfigService } from '../../config/app-config-service';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import { buildSessionConfigFromDeps } from '../session-config';
import { buildRealSessionTypePolicy } from '../../agent/__helpers__/session-type-policy-test-helper';
import { ulid } from '../../config/ulid';
import type { SessionHandlerDeps } from '../session';
// [v0.0.56] SessionKind for test kind construction
import { SessionKind } from '@app/shared';
// v0.0.204 T2-B2：TOOL_POLICY 已删（迁 profile yaml）；测试期望值改硬编码 const 替代旧 TOOL_POLICY[key].bound。
// 这些是 playground-rocky 22 工具（v0.0.223 default.yaml 加 todo，playground-rocky extends default 继承）/ subagent 21 工具的固化期望（profile yaml 等价表的镜像）。
const PG_ROCKY_BOUND = [
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'memory',
  'skill_manage', 'memory_manage',
  'web_search', 'web_fetch', 'browser', 'see_image', 'agent', 'send_message',
  'cron', 'ask-question', 'computer', 'history_search', 'history_get_context',
  'todo',
];
const SUBAGENT_BOUND = [
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'memory',
  'web_search', 'web_fetch', 'browser', 'see_image', 'send_message',
  'computer', 'ask-question', 'history_search', 'history_get_context',
  'student_sample', 'student_grade',
];

// [v0.0.56 hotfix] kind 必传（pos 5）—— 测试用 helper
const KIND_PG_MAIN = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });
const KIND_PG_SUB = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'subagent',  });
const KIND_STUDIO_MATE_SUB = new SessionKind({ biz: 'studio', role: 'mate', derivation: 'subagent',  });

let tmpRoot: string;
let deps: SessionHandlerDeps;
let store: SessionStore;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-cfg-policy-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  const appConfig = new AppConfigService({ root: tmpRoot });
  const bs = await bootstrapBuiltinPlugins(mkdtempSync(join(tmpdir(), 'cfg-policy-bs-')));
  appConfig.set('providers', 'mock-prov', {
    id: 'mock-prov', name: 'mock', enabled: true, kind: 'mock',
    credential: {},
    models: [{ modelId: 'mock-model' }],
  });
  deps = { store, agentManager: bs.agentManager, appConfig, pluginManager: bs.pluginManager, contextEngine: bs.contextEngine, dataDir: tmpRoot, sessionTypePolicy: buildRealSessionTypePolicy(tmpRoot) };
});

afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

const toolNames = (tools: unknown) =>
  (tools as Array<{ definition: { name: string } }>).map((t) => t.definition.name);

// ============================================================
// 1. playground-rocky（顶层 standalone）：tools = bound 12（B1 防 squad 泄漏）
// ============================================================

describe('buildSessionConfigFromDeps — playground-rocky（v0.0.48 B1 修复）', () => {
  it('顶层 standalone：tools = PG_ROCKY_BOUND（profile playground-rocky:parent:main，含 agent 不含 squad 工作项）', () => {
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', modelId: 'mock-model' },
      KIND_PG_MAIN, join(tmpRoot, 'ws'),
    );
    const names = toolNames(config.tools);
    expect(names.sort()).toEqual([...PG_ROCKY_BOUND].sort());
    expect(names).not.toContain('team');
    expect(names).not.toContain('goal');
    expect(names).not.toContain('requirement');
    expect(names).not.toContain('task');
    expect(names).toContain('agent');
  });

  it('deps.sessionTypePolicy 未注入 → fail-fast throw（policy 必填，无 lazy 兜底）', () => {
    const depsNoPolicy: SessionHandlerDeps = { ...deps, sessionTypePolicy: undefined };
    expect(() =>
      buildSessionConfigFromDeps(
        depsNoPolicy, ulid(), { providerId: 'mock-prov', modelId: 'mock-model' },
        KIND_PG_MAIN, join(tmpRoot, 'ws'),
      ),
    ).toThrow(/deps\.sessionTypePolicy 未注入/);
  });
});

// ============================================================
// 2. subagent mainAllowedTools ∩ bound（B2 防 schema/exec 不对齐）
// ============================================================

describe('buildSessionConfigFromDeps — subagent mainAllowedTools ∩ bound', () => {
  it('playground-subagent mainAllowedTools=[read,agent,goal] → [read]（agent/goal 被 bound 剥离）', () => {
    // mainAllowedTools=[read,agent,goal] ∩ subagent.bound(11) = [read]
    const subAgentConfig = {
      systemPrompt: 'explorer',
      tools: ['read', 'agent', 'goal'],
      maxIter: 10,
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', modelId: 'mock-model' },
      KIND_PG_SUB, join(tmpRoot, 'ws'),
      'subagent', subAgentConfig,
    );
    expect(toolNames(config.tools)).toEqual(['read']);
  });

  it('playground-subagent mainAllowedTools=[bash,send_message] → [bash,send_message]（都在 bound 内）', () => {
    const subAgentConfig = {
      systemPrompt: 'explorer',
      tools: ['bash', 'send_message'],
      maxIter: 10,
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', modelId: 'mock-model' },
      KIND_PG_SUB, join(tmpRoot, 'ws'),
      'subagent', subAgentConfig,
    );
    const names = toolNames(config.tools);
    expect(names.sort()).toEqual(['bash', 'send_message']);
  });

  it('playground-subagent mainAllowedTools=[]（空）→ config.tools 空（无 fallback）', () => {
    const subAgentConfig = {
      systemPrompt: 'restricted',
      tools: [],
      maxIter: 5,
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', modelId: 'mock-model' },
      KIND_PG_SUB, join(tmpRoot, 'ws'),
      'subagent', subAgentConfig,
    );
    expect(toolNames(config.tools)).toEqual([]);
  });

  it('subagent（v0.0.204 T2-B2: scope 字段已删，仅验 kind.isSubagent）', () => {
    const subAgentConfig = {
      systemPrompt: 'explorer',
      tools: ['read'],
      maxIter: 5,
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', modelId: 'mock-model' },
      KIND_PG_SUB, join(tmpRoot, 'ws'),
      'subagent', subAgentConfig, undefined,
    );
    // v0.0.204 T2-B2: scope 字段已删（零消费）；subagent 身份由 kind.isSubagent 表达
    expect(config.kind?.isSubagent).toBe(true);
  });
});

// ============================================================
// 3. studio-subagent mainAllowedTools ∩ subagent.bound（与 parent.bound 无关）
//    参考: tool_policy.md §3——subagent resolve = mainAllowedTools ∩ subagent.bound。
// ============================================================

describe('buildSessionConfigFromDeps — studio-subagent main ∩ subagent.bound', () => {
  it('studio-mate 派生 [browser,goal] → [browser]（goal 被 subagent.bound 剥离）', () => {
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', modelId: 'mock-model' },
      KIND_STUDIO_MATE_SUB, join(tmpRoot, 'ws'),
      'subagent',
      { systemPrompt: 'explorer', tools: ['browser', 'goal'], maxIter: 10 },
    );
    expect(toolNames(config.tools)).toEqual(['browser']);
  });

  it('studio-mate 派生 [browser,agent] → [browser]（agent 被 subagent.bound 剥离，即便 mate.bound 含 agent）', () => {
    // agent 在 mate.bound 内，但 subagent.bound 无 agent → 第一道 ∩ 即剥离（subagent 结构上不可再派生）
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', modelId: 'mock-model' },
      KIND_STUDIO_MATE_SUB, join(tmpRoot, 'ws'),
      'subagent',
      { systemPrompt: 'explorer', tools: ['browser', 'agent'], maxIter: 10 },
    );
    expect(toolNames(config.tools)).toEqual(['browser']);
  });

  it('重启恢复：subagent resolve 从 kind + subAgentConfig（session record 持久化 role+biz+derivation）', async () => {
    // createChildSessionImpl 落盘 role=parent.role（bloodline）+ biz+derivation；
    // 重启 resolveConfig 从 record 构造 kind，走 resolveTools(kind, mainAllowedTools)。
    const sid = ulid();
    const ws = join(tmpRoot, 'ws-restart');
    await store.createSession({
      id: sid,
      role: 'mate',
      derivation: 'subagent',
      biz: 'studio',
      parentSessionId: ulid(),
      workspaceDir: ws,
      subAgentConfig: {
        systemPrompt: 'explorer',
        tools: ['browser', 'agent', 'goal'],
        maxIter: 5,
      },
    });
    const got = await store.getSession(sid);
    expect(got?.subAgentConfig?.tools).toEqual(['browser', 'agent', 'goal']);
    // [v0.0.56 hotfix] 从 got record 构造 kind（与 session-compact.ts 同款逻辑）
    const kind = new SessionKind({
      biz: got!.biz ?? 'playground',
      role: got!.role ?? 'rocky',
      derivation: got!.derivation ?? 'parent',
    });
    const config = buildSessionConfigFromDeps(
      deps, sid, { providerId: 'mock-prov', modelId: 'mock-model' },
      kind, got!.workspaceDir, got!.derivation === 'subagent' ? 'subagent' : 'session', got!.subAgentConfig,
    );
    // browser ∩ subagent.bound = [browser]（agent/goal 被 subagent.bound 剥离）
    expect(toolNames(config.tools)).toEqual(['browser']);
  });
});
