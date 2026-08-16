/**
 * system-prompt-builder UT — v0.0.64 P1 builder 硬失败契约
 * 参考: specs/tech/agent/context/[P0]system_prompt.md §1/§3/§5
 *       reqs/[working] v0.0.64/req.md P1（用户确认的设计改进）
 *
 * 验证三条契约：
 *   ① buildSystemPrompt(null, config) → throw（无 pluginManager，rocky_context builtin 必须加载）
 *   ② buildSystemPrompt(emptyRegistry, config) → throw（mapper 链空 + 含诊断信息）
 *   ③ buildSystemPrompt(validRegistry, config) → 返回非空完整字符串（12 mapper + 3 reducer 跑通）
 *
 * 端到端验证（经 BuiltinLoader 加载真实 rocky_context plugin 39 impl）：
 *   - ③ 含 identity（Rocky）/ rules / context_files（PROJECT-MARKER）/ skills 等 fragment
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

let tmpRoot: string;
let emptyPm: PluginManager;
let validPm: PluginManager;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-builder-'));
  // v0.0.179：加载真实 default.yaml（impl 列表模型，membership = active）
  const realScopes = join(__dirname, '../../../../plugins/scopes');
  const { ScopeConfigLoader } = await import('../../plugin/scope-config-loader');
  const scopeConfigs = new ScopeConfigLoader(realScopes).loadAll();
  const defaultProvider = new LoadedScopeConfigProvider(scopeConfigs);

  // 空 registry fixture（EP 注册但无 impl 登记）
  const emptyRegistry = new Registry();
  for (const ep of BUILTIN_EXTENSION_POINTS) emptyRegistry.registerExtensionPoint(ep);
  emptyPm = new PluginManager({ registry: emptyRegistry, scopeConfigs: defaultProvider });

  // 完整 rocky_context fixture（BuiltinLoader 加载 10 prompt_mapper + 3 reducer）
  const fullRegistry = new Registry();
  for (const ep of BUILTIN_EXTENSION_POINTS) fullRegistry.registerExtensionPoint(ep);
  const realBuiltins = join(__dirname, '../../../../plugins/builtins');
  await new BuiltinLoader(realBuiltins).loadAll(fullRegistry);
  validPm = new PluginManager({ registry: fullRegistry, scopeConfigs: defaultProvider });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function mkConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    sessionId: 'test-sid',
    systemPrompt: 'PLACEHOLDER',
    client: { contextWindow: 100000 } as unknown as LlmClient,
    modelId: 'm',
    providerId: 'p-m',
    workdir: tmpRoot,
    ...overrides,
  };
}

describe('system-prompt-builder 硬失败契约（v0.0.64 P1）', () => {
  it('① buildSystemPrompt(null, config) → throw（无 pluginManager）', async () => {
    await expect(buildSystemPrompt(null, mkConfig())).rejects.toThrowError(
      /pluginManager required.*rocky_context builtin must load.*no fallback/,
    );
  });

  it('② buildSystemPrompt(emptyRegistry, config) → throw（mapper 链空，含诊断信息）', async () => {
    await expect(buildSystemPrompt(emptyPm, mkConfig())).rejects.toThrowError(
      /system_prompt_mapper chain empty.*registry plugins:/,
    );
  });

  it('② throw 信息不含 PLACEHOLDER（无 silent fallback 到 config.systemPrompt）', async () => {
    // 关键：mapper 链空时绝不返回 config.systemPrompt 占位（silent degradation）
    let caught: unknown;
    try {
      await buildSystemPrompt(emptyPm, mkConfig({ systemPrompt: 'LEAK-CHECK' }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain('LEAK-CHECK');
  });
});

describe('system-prompt-builder 完整链构建（rocky_context 39 impl）', () => {
  it('③ buildSystemPrompt(validRegistry, config) → 返回非空完整 system prompt', async () => {
    // 写 AGENTS.md 让 context_files mapper 贡献可识别 marker
    writeFileSync(join(tmpRoot, 'AGENTS.md'), 'BUILDER-TEST-PROJECT-MARKER');

    const text = await buildSystemPrompt(validPm, mkConfig());
    expect(text).toBeTruthy();
    expect(text.length).toBeGreaterThan(1000); // 完整 system prompt 通常 7000+ 字符

    // 含 identity（Rocky）+ rules + context_files（marker）等关键 fragment
    expect(text).toMatch(/Rocky/i);
    expect(text).toContain('BUILDER-TEST-PROJECT-MARKER');

    // 不含占位（已被 builder 覆盖）
    expect(text).not.toContain('PLACEHOLDER');
  });
});

describe('system-prompt-builder scope 感知（scopeId 透传 getExtensionImpls，scope 级覆写生效）', () => {
  it('scopeId 实参透传到 getExtensionImpls（mapper + reducer 双链同 scope）', async () => {
    const spy = vi.spyOn(validPm, 'getExtensionImpls');
    await buildSystemPrompt(validPm, mkConfig(), 'studio-leader:parent:main');
    // mapper + reducer 两次调用都必须带 scopeId（漏一个 = 半链路死配置）
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of spy.mock.calls) {
      expect(c[1]).toBe('studio-leader:parent:main');
    }
  });
});
