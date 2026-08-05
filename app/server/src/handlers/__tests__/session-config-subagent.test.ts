/**
 * buildSessionConfigFromDeps — [v0.0.28] subAgentConfig 覆盖测试
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §4（eff 持久化 + resolveConfig 重建）
 *
 * 验证 Bug 2 修复：spawn 时 eff（systemPrompt/tools/maxIter）必须持久化到 session record，
 * buildSessionConfigFromDeps 读 subAgentConfig 覆盖空字符串占位/defaultTools/appConfig.maxIter。
 *   [v0.0.64 P1] DEFAULT_SYSTEM_PROMPT 删除——非 subAgentConfig 走空字符串占位由 builder 覆盖。
 *
 * 修复前：createChildSessionImpl 丢弃 eff → child 用默认占位跑
 *         （explorer 不探查直接 no_tool_call）。
 * 修复后：subAgentConfig 持久化 → child 用 explorer 人设 + 全集工具 + scope='subagent' 跑
 *         （[v0.0.30 简化] session-config 层不再按 subAgentConfig.tools 白名单过滤 tools；
 *          agent 排除由 scope 在 agent-loop 层 deriveAllowedTools 做，见 scope-allowed-tools UT）。
 *
 * 全链路：createSession(含 subAgentConfig) → getSession 读出 → buildSessionConfigFromDeps 覆盖。
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
// [v0.0.56 hotfix] kind 必传（pos 5）
import { SessionKind } from '@app/shared';
const KIND_PG_MAIN = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });
const KIND_PG_SUB = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'subagent',  });
import { ulid } from '../../config/ulid';
import type { SessionHandlerDeps } from '../session';

let tmpRoot: string;
let store: SessionStore;
let deps: SessionHandlerDeps;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-subagent-cfg-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  const appConfig = new AppConfigService({ root: tmpRoot });
  const bs = await bootstrapBuiltinPlugins(tmpRoot);
  appConfig.set('providers', 'mock-prov', {
    id: 'mock-prov', name: 'mock', enabled: true, kind: 'mock',
    credential: {}, models: [{ modelId: 'mock-model' }],
  });
  deps = { store, agentManager: bs.agentManager, appConfig, pluginManager: bs.pluginManager, contextEngine: bs.contextEngine, dataDir: tmpRoot, sessionTypePolicy: buildRealSessionTypePolicy(tmpRoot) };
});

afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

describe('buildSessionConfigFromDeps — [v0.0.28] subAgentConfig 覆盖', () => {
  it('subAgentConfig 持久化 → getSession 读出 → 覆盖 systemPrompt/tools/maxIter', async () => {
    // 1. createSession 落 subAgentConfig（模拟 spawn createChildSessionImpl）
    const subAgentConfig = {
      systemPrompt: '你是 explorer 子 agent，只读探查',
      tools: ['read', 'web_search', 'web_fetch', 'send_message'],
      maxIter: 15,
    };
    const childSid = ulid();
    const child = await store.createSession({
      id: childSid, title: 'explorer', derivation: 'subagent',
      parentSessionId: ulid(), subAgentTemplateType: 'explorer',
      subAgentConfig, providerId: 'mock-prov', modelId: 'mock-model',
    });

    // 2. getSession 读出 subAgentConfig（验证持久化 + 反序列化）
    const fetched = await store.getSession(childSid);
    expect(fetched?.subAgentConfig).toEqual(subAgentConfig);

    // 3. buildSessionConfigFromDeps 用 subAgentConfig 覆盖默认
    const config = buildSessionConfigFromDeps(
      deps, childSid,
      { providerId: 'mock-prov', modelId: 'mock-model' },
      KIND_PG_SUB, undefined, 'subagent', fetched?.subAgentConfig,
    );

    // systemPrompt = explorer 人设（subAgentConfig.systemPrompt 覆盖空字符串占位）
    expect(config.systemPrompt).toBe('你是 explorer 子 agent，只读探查');

    // maxIterations = subAgentConfig.maxIter（非顶层默认 DEFAULT_MAX_ITERATIONS）
    expect(config.maxIterations).toBe(15);

    // tools = defaultTools 按 subAgentConfig.tools 白名单过滤（#1 恢复白名单：explorer 只读语义；
    // v0.0.30 全集模式已废弃）。subAgentConfig.tools 决定 child 工具集，session-config 层过滤。
    // subagent 不可再派生（agent 工具排除）双重保险：①白名单本身不含 agent（explorer 4 工具）；
    // ②scope='subagent' 挂 config，agent-loop 层 deriveAllowedTools 再排除 agent（见 scope-allowed-tools.ts）。
    const toolNames = (config.tools as Array<{ definition: { name: string } }>).map((t) => t.definition.name);
    // explorer 白名单 4 工具（subAgentConfig.tools 持久化 + systemPrompt/maxIter 覆盖是本测试核心）
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('web_search');
    expect(toolNames).toContain('web_fetch');
    expect(toolNames).toContain('send_message');
    // 白名单过滤后不含 agent/bash/write（explorer 只读，无写/bash；agent 由 profile subagent.bound 排除）
    expect(toolNames).not.toContain('agent');
    expect(toolNames).not.toContain('bash');
    expect(toolNames).not.toContain('write');
    // v0.0.204 T2-B2: scope 字段已删；subagent 身份由 kind.isSubagent 表达
    expect(config.kind?.isSubagent).toBe(true);
  });

  it('无 subAgentConfig（顶层 session）→ 走默认 systemPrompt/tools/maxIter（向后兼容）', () => {
    const config = buildSessionConfigFromDeps(
      deps, ulid(),
      { providerId: 'mock-prov', modelId: 'mock-model' },
      KIND_PG_MAIN, undefined, undefined, undefined,
    );
    // 顶层 session：全工具集（含 agent/bash/file_write）
    const toolNames = (config.tools as Array<{ definition: { name: string } }>).map((t) => t.definition.name);
    expect(toolNames).toContain('agent');
    expect(toolNames).toContain('bash');
    // maxIterations 走顶层默认 DEFAULT_MAX_ITERATIONS（agent-loop-lifecycle.ts = 200）
    expect(config.maxIterations).toBe(200);
  });

  it('subAgentConfig.skills 覆盖也持久化（inline spawn 带 skills）', async () => {
    const sid = ulid();
    await store.createSession({
      id: sid, title: 'custom', derivation: 'subagent',
      parentSessionId: ulid(),
      subAgentConfig: {
        systemPrompt: '自定义', tools: ['read'], skills: ['my-skill'], maxIter: 10,
      },
    });
    const fetched = await store.getSession(sid);
    expect(fetched?.subAgentConfig?.skills).toEqual(['my-skill']);
    expect(fetched?.subAgentConfig?.maxIter).toBe(10);
  });
});
