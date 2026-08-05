/**
 * T7 端到端集成测试：builtin llm_anthropic plugin 经 builtin-loader 扫描 → registry 登记
 *   → PluginManager.getExtensionImpls 返回 T3 AnthropicCompatibleProvider / AnthropicMessagesProtocol 实例
 * 参考: specs/tech/plugin_system/[P0]builtin_plugins_directory.md §2/§3（目录结构 + 扫描流程）
 *       specs/tech/plugin_system/[P0]plugin_manager_interface.md §3.4（静态注册 + get 时实例化）
 *       states/v0.0.3/task.json T7 acceptanceCriteria
 *
 * 测试策略：扫描**真实** app/plugins/builtins/ 仓库目录（不是 tmp），验证 T7 产出的
 * plugin.json + re-export 文件与 T2 builtin-loader + T3 provider/protocol 类正确对接。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Registry } from '../registry';
import { PluginManager } from '../plugin-manager';
import { PluginPolicyStore } from '../plugin-policy-store';
import { LoadedScopeConfigProvider } from '../scope-config-provider';
import { BuiltinLoader } from '../builtin-loader';
import {
  LlmProviderPoint,
  LlmProtocolPoint,
  BUILTIN_EXTENSION_POINTS,
} from '../extension-point';

/** 仓库内真实 builtins 目录（app/plugins/builtins） */
const REAL_BUILTINS_ROOT = path.resolve(
  __dirname,
  '../../../../plugins/builtins',
);

let tmpPolicyRoot: string;
let store: PluginPolicyStore;

beforeEach(() => {
  tmpPolicyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-t7-'));
  store = new PluginPolicyStore({ root: tmpPolicyRoot });
});

afterEach(() => {
  fs.rmSync(tmpPolicyRoot, { recursive: true, force: true });
});

describe('T7 builtin llm_anthropic plugin — 目录结构权威校验', () => {
  it('app/plugins/builtins/llm_anthropic/ 目录存在', () => {
    expect(fs.existsSync(REAL_BUILTINS_ROOT)).toBe(true);
    const dir = path.join(REAL_BUILTINS_ROOT, 'llm_anthropic');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('llm_anthropic/plugin.json 存在且 manifest.id == "llm_anthropic"（目录名镜像 builtin §4.2）', () => {
    const manifestPath = path.join(REAL_BUILTINS_ROOT, 'llm_anthropic', 'plugin.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.id).toBe('llm_anthropic');
  });

  it('manifest extImpls 引用 llm_provider → anthropic_compatible + llm_protocol → anthropic_messages', () => {
    const manifestPath = path.join(REAL_BUILTINS_ROOT, 'llm_anthropic', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(Array.isArray(manifest.extImpls)).toBe(true);
    expect(manifest.extImpls.length).toBeGreaterThanOrEqual(2);

    const providerExt = manifest.extImpls.find(
      (e: { point: string }) => e.point === 'llm_provider',
    );
    const protocolExt = manifest.extImpls.find(
      (e: { point: string }) => e.point === 'llm_protocol',
    );
    expect(providerExt).toBeDefined();
    expect(providerExt.implId).toBe('anthropic_compatible');
    expect(typeof providerExt.impl).toBe('string'); // 相对路径
    expect(protocolExt).toBeDefined();
    expect(protocolExt.implId).toBe('anthropic_messages');
    expect(typeof protocolExt.impl).toBe('string');
  });
});

describe('T7 端到端：builtin-loader 扫描真实 builtins → registry 登记', () => {
  let registry: Registry;

  beforeEach(async () => {
    registry = new Registry();
    // 登记内置扩展点（cardinality 解析依赖）
    for (const ep of BUILTIN_EXTENSION_POINTS) {
      registry.registerExtensionPoint(ep);
    }
    const loader = new BuiltinLoader(REAL_BUILTINS_ROOT);
    await loader.loadAll(registry);
  });

  it('llm_anthropic 已登记进 registry', () => {
    expect(registry.listPlugins()).toContain('llm_anthropic');
  });

  it('registry.getByPoint(llm_provider) 返回 anthropic_compatible 条目', () => {
    const entries = registry.getByPoint('llm_provider');
    const hit = entries.find((e) => e.manifest.implId === 'anthropic_compatible');
    expect(hit).toBeDefined();
    expect(hit!.pluginId).toBe('llm_anthropic');
    // 登记的是类引用（function），未实例化（plugin_manager §3.4）
    expect(typeof hit!.implClass).toBe('function');
  });

  it('registry.getByPoint(llm_protocol) 返回 anthropic_messages 条目', () => {
    const entries = registry.getByPoint('llm_protocol');
    const hit = entries.find((e) => e.manifest.implId === 'anthropic_messages');
    expect(hit).toBeDefined();
    expect(hit!.pluginId).toBe('llm_anthropic');
    expect(typeof hit!.implClass).toBe('function');
  });
});

describe('T7 端到端：PluginManager.getExtensionImpls 返回正确实例', () => {
  let manager: PluginManager;

  beforeEach(async () => {
    const registry = new Registry();
    for (const ep of BUILTIN_EXTENSION_POINTS) {
      registry.registerExtensionPoint(ep);
    }
    const loader = new BuiltinLoader(REAL_BUILTINS_ROOT);
    await loader.loadAll(registry);
    // v0.0.179：加载真实 default.yaml（impl 列表模型，membership = active）
    const realScopes = path.join(__dirname, '../../../../plugins/scopes');
    const { ScopeConfigLoader } = await import('../scope-config-loader');
    const scopeConfigs = new ScopeConfigLoader(realScopes).loadAll();
    manager = new PluginManager({
      registry,
      scopeConfigs: new LoadedScopeConfigProvider(scopeConfigs),
    });
  });

  it('getExtensionImpls(LlmProviderPoint) 返回 AnthropicCompatibleProvider 实例（implId 正确）', () => {
    const providers = manager.getExtensionImpls<{ implId: string }>(LlmProviderPoint);
    expect(providers.length).toBeGreaterThanOrEqual(1);
    const anthropic = providers.find((p) => p.implId === 'anthropic_compatible');
    expect(anthropic).toBeDefined();
  });

  it('getExtensionImpls(LlmProtocolPoint) 返回 AnthropicMessagesProtocol 实例（implId 正确）', () => {
    const protocols = manager.getExtensionImpls<{
      implId: string;
      path: string;
    }>(LlmProtocolPoint);
    expect(protocols.length).toBeGreaterThanOrEqual(1);
    const anthropic = protocols.find((p) => p.implId === 'anthropic_messages');
    expect(anthropic).toBeDefined();
    // T3 protocol 自承载 path='/v1/messages'（builtin_plugins_directory §2.2）
    expect(anthropic!.path).toBe('/v1/messages');
  });

  it('每次 get 都返回新实例（config 变更 next-get 反映，plugin_manager §3.4）', () => {
    const a1 = manager.getExtensionImpls<{ implId: string }>(LlmProviderPoint);
    const a2 = manager.getExtensionImpls<{ implId: string }>(LlmProviderPoint);
    const x1 = a1.find((p) => p.implId === 'anthropic_compatible');
    const x2 = a2.find((p) => p.implId === 'anthropic_compatible');
    expect(x1).toBeDefined();
    expect(x2).toBeDefined();
    expect(x1).not.toBe(x2); // 不同实例
  });

  it('v0.0.179 impl 级 inactive 来自 membership：default scope impls 不列 anthropic_compatible → 不返', async () => {
    const registry = new Registry();
    for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
    await new BuiltinLoader(REAL_BUILTINS_ROOT).loadAll(registry);
    const m = new PluginManager({
      registry,
      scopeConfigs: new LoadedScopeConfigProvider([
        {
          scopeId: 'default', name: 'Default',
          // v0.0.179：anthropic_compatible 不在 impls 字典 = inactive（membership 模型）
          activatedPoints: [],
          impls: {},
        },
      ]),
    });
    const providers = m.getExtensionImpls<{ implId: string }>(LlmProviderPoint);
    expect(providers.find((p) => p.implId === 'anthropic_compatible')).toBeUndefined();
  });

  it('v0.0.67 plugin 级 native 受信恒 true：无 plugin toggle 概念，plugin impl 永远 active', () => {
    // v0.0.67 不再有 plugin 级 enabled 落盘（PRD OUT + D1 secret 不进代码声明）
    // 想「关 plugin 级」必须 per-impl disable（同上测试）
    const providers = manager.getExtensionImpls<{ implId: string }>(LlmProviderPoint);
    expect(providers.find((p) => p.implId === 'anthropic_compatible')).toBeDefined();
  });
});
