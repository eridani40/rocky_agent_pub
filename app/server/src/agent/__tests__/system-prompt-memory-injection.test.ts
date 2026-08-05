/**
 * system-prompt-builder 端到端 L0 注入不变量 UT
 * 参考: specs/tech/agent/memory/[P0]memory_injection.md §2/§3（L0 注入：name+intro 注入，body 不注入）
 *       specs/tech/agent/context/[P0]system_prompt.md §1/§3（builder = mapper 链 → reducer 链 → 固定 join）
 *
 * 背景（v0.0.132 补漏）：v0.0.131 删除 AT case `memory_http_contract` 后，"system prompt 含 memory
 *   name+intro 但不含 body 正文" 这一 prompt 卫生 / 隐私不变量失去自动 guard。
 *   - 已有 UT（app/plugins/builtins/rocky_context/__tests__/memory-injection-l0.test.ts
 *     + prompt/__tests__/memory-mapper.test.ts）只断言 mapper.map() 输出的 fragment
 *   - 本 UT 在**最终组装的 system prompt 字符串**层验证不变量——覆盖 mapper → reducer → builder join
 *     全链路：即便某个 reducer（tier_sort/dedup/budget_truncate）将来回归出注入 body 的 bug，本 UT 会抓到
 *
 * 断言契约（每条 memory entry 必须满足）：
 *   - 最终 system prompt 含 entry.name（L0 索引）
 *   - 最终 system prompt 含 entry.intro（一句话摘要）
 *   - 最终 system prompt **不含** body 正文 marker（核心负向断言，隐私红线）
 *   - 最终 system prompt 不含 why / howToApply（aux 字段同样不进 L0）
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach 清理；global memory 走 globalMemoryDir(dataDir=tmp)，
 *   session memory 走 wsMemoryDir(workdir)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../plugin/registry';
import { PluginManager } from '../../plugin/plugin-manager';
import { BuiltinLoader } from '../../plugin/builtin-loader';
import { BUILTIN_EXTENSION_POINTS } from '../../plugin/extension-point';
import { LoadedScopeConfigProvider } from '../../plugin/scope-config-provider';
import { buildSystemPrompt } from '../system-prompt-builder';
import type { SessionConfig } from '../context-types';
import type { LlmClient } from '../../llm/client';
import { AppConfigService } from '../../config/app-config-service';
import {
  globalMemoryDir,
  wsMemoryDir,
} from '../../memory/memory-dir-store';
import { writeEntry } from '../../memory/memory-dir-write';

// —— body marker：唯一可识别串，确保负向断言精确（任何泄漏立刻定位）——
const USER_BODY_MARKER = 'UNIQUE_USER_BODY_MARKER_L0_TEST_DO_NOT_INJECT';
const USER_WHY_MARKER = 'UNIQUE_USER_WHY_MARKER_L0_TEST';
const USER_HOW_MARKER = 'UNIQUE_USER_HOW_MARKER_L0_TEST';
const SESSION_BODY_MARKER = 'UNIQUE_SESSION_BODY_MARKER_L0_TEST_DO_NOT_INJECT';

const SID = 'sess-sp-builder-memory-001';

let tmpRoot: string;
let appConfig: AppConfigService;
let validPm: PluginManager;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-memory-inject-'));
  appConfig = new AppConfigService({ root: tmpRoot });

  // 完整 rocky_context fixture（11 prompt_mapper + 3 reducer 经 BuiltinLoader 注册）
  const registry = new Registry();
  for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
  const realBuiltins = join(__dirname, '../../../../plugins/builtins');
  await new BuiltinLoader(realBuiltins).loadAll(registry);
  // v0.0.179：加载真实 default.yaml（impl 列表模型，membership = active）
  const realScopes = join(__dirname, '../../../../plugins/scopes');
  const { ScopeConfigLoader } = await import('../../plugin/scope-config-loader');
  const scopeConfigs = new ScopeConfigLoader(realScopes).loadAll();
  const defaultProvider = new LoadedScopeConfigProvider(scopeConfigs);
  validPm = new PluginManager({ registry, scopeConfigs: defaultProvider });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造 SessionConfig，注入 appConfig + dataDir + workdir（memory mapper 三依赖） */
function mkConfig(): SessionConfig {
  return {
    sessionId: SID,
    systemPrompt: 'PLACEHOLDER',
    client: { contextWindow: 100000 } as unknown as LlmClient,
    modelId: 'm',
    workdir: tmpRoot,
    appConfig,
    dataDir: tmpRoot,
  } as SessionConfig;
}

describe('buildSystemPrompt 端到端 L0 注入不变量', () => {
  it('global memory：system prompt 含 name+intro，不含 body/why/how（隐私红线）', async () => {
    // 灌一条带明显 body marker 的 global memory
    await writeEntry(globalMemoryDir(tmpRoot), {
      name: 'prefers-concise-answers',
      intro: 'User prefers concise responses over verbose ones',
      type: 'user',
      body: `${USER_BODY_MARKER} — long sensitive body content that must NEVER reach the system prompt.`,
      why: USER_WHY_MARKER,
      howToApply: USER_HOW_MARKER,
    }, {});

    const prompt = await buildSystemPrompt(validPm, mkConfig());

    // 正向：name + intro 必须进 L0
    expect(prompt).toContain('prefers-concise-answers');
    expect(prompt).toContain('User prefers concise responses over verbose ones');

    // 负向（核心红线）：body / why / howToApply 绝不进 system prompt
    expect(prompt).not.toContain(USER_BODY_MARKER);
    expect(prompt).not.toContain(USER_WHY_MARKER);
    expect(prompt).not.toContain(USER_HOW_MARKER);
  });

  it('session memory：system prompt 含 name+intro，不含 body 正文', async () => {
    await writeEntry(wsMemoryDir(tmpRoot), {
      name: 'project-decision-log',
      intro: 'Key architecture decision for the current session',
      type: 'project',
      body: `${SESSION_BODY_MARKER} — detailed decision rationale kept on disk, out of prompt.`,
    }, {});

    const prompt = await buildSystemPrompt(validPm, mkConfig());

    // 正向：session memory L0
    expect(prompt).toContain('project-decision-log');
    expect(prompt).toContain('Key architecture decision for the current session');

    // 负向：session body 不进 prompt
    expect(prompt).not.toContain(SESSION_BODY_MARKER);
  });

  it('多 memory 共存：各自 name+intro 都进，所有 body 都不进', async () => {
    // global scope 一条 + session scope 一条，name/intro/body 各自不同 marker
    await writeEntry(globalMemoryDir(tmpRoot), {
      name: 'user-pref-a',
      intro: 'User-level preference A summary',
      type: 'user',
      body: USER_BODY_MARKER,
    }, {});
    await writeEntry(wsMemoryDir(tmpRoot), {
      name: 'session-note-b',
      intro: 'Session-level note B summary',
      type: 'project',
      body: SESSION_BODY_MARKER,
    }, {});

    const prompt = await buildSystemPrompt(validPm, mkConfig());

    // 两 scope 的 L0 都进 prompt
    expect(prompt).toContain('user-pref-a');
    expect(prompt).toContain('User-level preference A summary');
    expect(prompt).toContain('session-note-b');
    expect(prompt).toContain('Session-level note B summary');

    // 两 scope 的 body 都不进 prompt
    expect(prompt).not.toContain(USER_BODY_MARKER);
    expect(prompt).not.toContain(SESSION_BODY_MARKER);
  });

  it('read hint 引导 agent 用 memory 工具读正文（L0 末尾签名）', async () => {
    await writeEntry(globalMemoryDir(tmpRoot), {
      name: 'hint-probe',
      intro: 'probe entry for read hint',
      type: 'user',
      body: USER_BODY_MARKER,
    }, {});
    const prompt = await buildSystemPrompt(validPm, mkConfig());
    // 末尾读正文引导（对齐 skill catalog progressive disclosure 哲学）
    expect(prompt).toMatch(/Use the `memory` tool to read a memory's full body by name\./);
  });
});
