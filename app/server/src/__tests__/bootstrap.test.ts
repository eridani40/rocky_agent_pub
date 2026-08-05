/**
 * bootstrap 单测 — 经 BuiltinLoader 扫描 builtins/llm_anthropic/plugin.json 登记内置 plugin
 * 参考: specs/api/overall/02-llm-chat.md §2.2（pluginId=llm_anthropic，spec 规定）
 *       specs/tech/plugin_system/[P0]builtin_plugins_directory.md §2/§3
 *
 * 校验点（精确断言，spec §2.2 一致）：
 *   - registry.listPoints() 含 llm_provider / llm_protocol
 *   - listPlugins() 含 plugin id `llm_anthropic`（不是 builtin.anthropic）
 *   - llm_provider point 下有 anthropic_compatible impl
 *   - llm_protocol point 下有 anthropic_messages impl
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { bootstrapBuiltinPlugins } from '../bootstrap';

describe('bootstrap.bootstrapBuiltinPlugins', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-bootstrap-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('注册 llm_provider + llm_protocol 扩展点', async () => {
    const { registry } = await bootstrapBuiltinPlugins(dataDir);
    const points = registry.listPoints();
    expect(points).toContain('llm_provider');
    expect(points).toContain('llm_protocol');
  });

  it('listPlugins() 含 plugin id `llm_anthropic`（经 BuiltinLoader 扫 T7 plugin.json）', async () => {
    const { registry } = await bootstrapBuiltinPlugins(dataDir);
    const ids = registry.listPlugins();
    expect(ids).toContain('llm_anthropic');
    expect(ids).not.toContain('builtin.anthropic');
  });

  it('llm_provider point 下登记 anthropic_compatible impl', async () => {
    const { registry } = await bootstrapBuiltinPlugins(dataDir);
    const providers = registry.getByPoint('llm_provider');
    const ids = providers.map((p) => p.manifest.implId);
    expect(ids).toContain('anthropic_compatible');
  });

  it('llm_protocol point 下登记 anthropic_messages impl', async () => {
    const { registry } = await bootstrapBuiltinPlugins(dataDir);
    const protos = registry.getByPoint('llm_protocol');
    const ids = protos.map((p) => p.manifest.implId);
    expect(ids).toContain('anthropic_messages');
  });
});

describe('bootstrap — [v0.0.67] PluginManager 注入 ScopeConfigProvider（代码声明读源）', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-bootstrap-scope-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('PluginManager 注入了 scopeConfigs（非 undefined）— v0.0.67 改读代码声明', async () => {
    // 参考: reqs/[working] v0.0.67.plugin_config_refactor/design.md §3 D2
    // v0.0.67：PluginManager 读源从 PluginPolicyStore 切到 ScopeConfigProvider（代码声明 = 唯一源）
    const { pluginManager } = await bootstrapBuiltinPlugins(dataDir);
    // 白盒断言（private 字段，UT 惯例用 as unknown as）
    const scopeConfigs = (pluginManager as unknown as {
      scopeConfigs?: unknown;
    }).scopeConfigs;
    expect(scopeConfigs).toBeDefined();
    expect(scopeConfigs).not.toBeNull();
  });

  it('PluginManager 与 PluginConfigService 共享同一 ScopeConfigProvider 实例（同源）', async () => {
    // 两者必须同源，否则 PluginManager 投影的 scope 配置与 inventory 返回的不一致
    const bs = await bootstrapBuiltinPlugins(dataDir);
    const pmProvider = (bs.pluginManager as unknown as {
      scopeConfigs?: unknown;
    }).scopeConfigs;
    // PluginConfigService 内部读 scopeConfigs 字段（白盒）
    const pcsProvider = (bs.pluginConfigService as unknown as {
      scopeConfigs?: unknown;
    }).scopeConfigs;
    expect(pmProvider).toBe(pcsProvider);
  });
});
