/**
 * PluginManager 单测（白盒）—— v0.0.67 改读代码声明后的 getExtensionImpls 投影
 * 参考: specs/tech/plugin_system/[P0]plugin_manager_interface.md §2/§3
 *       reqs/[working] v0.0.67.plugin_config_refactor/design.md §3 D2（落盘 policy 弃用）
 *
 * v0.0.67 重构（D2）：
 *   - 读源从 PluginPolicyStore（落盘）改为 ScopeConfigProvider（代码声明）
 *   - impl 级 enabled/order/configValues 全部从 ScopeConfig.impls[id] 取
 *   - plugin 级 enabled：恒 true（native 受信，scopes/*.json 不存 plugin 级开关）
 *
 * 覆盖：
 *   - P0 默认全开（无 ScopeConfig.impls 声明 → 所有 impl enabled=true）
 *   - impl 级 enabled=false 通过 ScopeConfig.impls 声明
 *   - get 每次新实例（非缓存）+ configValues 注入
 *   - BUG-003：manifest configSchema.properties.{key}.default 注入 + 代码声明 configValues 覆盖
 *   - cardinality=list 多 impl 返全部
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { Registry } from '../registry';
import { PluginManager } from '../plugin-manager';
import {
  LlmProviderPoint,
  LlmProtocolPoint,
} from '../extension-point';
import { LoadedScopeConfigProvider } from '../scope-config-provider';
import type { ScopeConfig } from '../scope-config-loader';
import type { PluginManifest, ExtImpl } from '../manifest';

let registry: Registry;
let configs: ScopeConfig[];
let mgr: PluginManager;

beforeEach(() => {
  registry = new Registry();
  registry.registerExtensionPoint(LlmProviderPoint);
  registry.registerExtensionPoint(LlmProtocolPoint);
  configs = [{ scopeId: 'default', name: 'Default', activatedPoints: [], impls: {} }];
});

function rebuild(): PluginManager {
  mgr = new PluginManager({
    registry,
    scopeConfigs: new LoadedScopeConfigProvider(configs),
  });
  return mgr;
}

class TestProvider {
  static instances: TestProvider[] = [];
  implId: string;
  cfg: unknown;
  constructor(implId: string, cfg: unknown) {
    this.implId = implId;
    this.cfg = cfg;
    TestProvider.instances.push(this);
  }
}
class TestProtocol {
  implId: string;
  constructor(implId: string, cfg: unknown) {
    this.implId = implId;
    void cfg;
  }
}

function regManifest(
  pluginId: string,
  extImpls: { implId: string; point: string }[],
): void {
  const full: ExtImpl[] = extImpls.map((e) => ({
    implId: e.implId,
    point: e.point,
    impl: './' + e.implId + '.ts',
  }));
  const m: PluginManifest = { id: pluginId, extImpls: full };
  const classes = extImpls.map((e) =>
    e.point === 'llm_provider' ? TestProvider : TestProtocol,
  );
  registry.register(m, ...classes);
}

describe('PluginManager.getExtensionImpls — v0.0.179 membership 模型（impl 在 impls 字典 = active）', () => {
  it('impls 列出 → 全部 active（membership = 在列表）', () => {
    regManifest('p1', [
      { implId: 'a', point: 'llm_provider' },
      { implId: 'b', point: 'llm_provider' },
    ]);
    TestProvider.instances = [];
    configs[0]!.impls = { a: { order: 1 }, b: { order: 2 } };
    const providers = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint);
    expect(providers).toHaveLength(2);
    expect(TestProvider.instances).toHaveLength(2);
    expect(providers.map((p) => p.implId).sort()).toEqual(['a', 'b']);
  });

  it('cardinality=list 返多个 active impl（按 cfg.order 升序）', () => {
    regManifest('p1', [
      { implId: 'openai', point: 'llm_provider' },
      { implId: 'anthropic', point: 'llm_provider' },
      { implId: 'glm', point: 'llm_provider' },
    ]);
    configs[0]!.impls = {
      openai: { order: 1 },
      anthropic: { order: 2 },
      glm: { order: 3 },
    };
    const providers = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint);
    expect(providers).toHaveLength(3);
    expect(providers.find((p) => p.implId === 'anthropic')).toBeDefined();
  });

  it('v0.0.179 不在 impls 字典 = inactive（不再 default true）', () => {
    regManifest('p1', [
      { implId: 'a', point: 'llm_provider' },
      { implId: 'b', point: 'llm_provider' },
    ]);
    // 不列任何 impl → 都 inactive → 返空
    const providers = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint);
    expect(providers).toEqual([]);
  });
});

describe('PluginManager.getExtensionImpls — impl 级 membership 门（ScopeConfig.impls）', () => {
  it('ScopeConfig.impls 不列 a → 该 impl 不 active（只列 b → 仅 b）', () => {
    regManifest('p1', [
      { implId: 'a', point: 'llm_provider' },
      { implId: 'b', point: 'llm_provider' },
    ]);
    configs[0]!.impls = { b: { order: 1 } }; // v0.0.179：不列 a = inactive
    const providers = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint);
    expect(providers.map((p) => p.implId)).toEqual(['b']);
  });

  it('plugin 级不再支持落盘 toggle：plugin impl 在 impls 字典 = active', () => {
    // v0.0.179：membership 模型；plugin 级 native 受信恒 true（无 plugin toggle 概念）
    // 想关单 impl → 不列在 impls 字典
    regManifest('p1', [{ implId: 'a', point: 'llm_provider' }]);
    regManifest('p2', [{ implId: 'b', point: 'llm_provider' }]);
    configs[0]!.impls = { a: { order: 1 }, b: { order: 2 } };
    const providers = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint);
    expect(providers.map((p) => p.implId).sort()).toEqual(['a', 'b']);
  });
});

describe('PluginManager.getExtensionImpls — get 时实例化（每次新对象）', () => {
  it('两次 get 返不同实例（按当前 config 实例化，非缓存）', () => {
    regManifest('p1', [{ implId: 'a', point: 'llm_provider' }]);
    configs[0]!.impls = { a: { order: 1 } };
    TestProvider.instances = [];
    const m = rebuild();
    const r1 = m.getExtensionImpls(LlmProviderPoint);
    const r2 = m.getExtensionImpls(LlmProviderPoint);
    expect(r1[0]).not.toBe(r2[0]);
    expect(TestProvider.instances).toHaveLength(2);
  });

  it('ScopeConfig.impls[a].configValues 注入实例化构造器参数', () => {
    regManifest('p1', [{ implId: 'a', point: 'llm_provider' }]);
    configs[0]!.impls = { a: { order: 1, configValues: { apiKey: 'sk-xxx' } } };
    const providers = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint);
    expect(providers[0]!.cfg).toMatchObject({ apiKey: 'sk-xxx' });
  });

  it('BUG-003：manifest configSchema.properties.{key}.default 注入 cfg（不靠 fallback）', () => {
    const m: PluginManifest = {
      id: 'p-bug003',
      extImpls: [{
        implId: 'bug-impl',
        point: 'llm_provider',
        impl: './bug-impl.ts',
        configSchema: {
          type: 'object',
          properties: {
            query_truncate: { type: 'number', default: 8000 },
            apiKey: { type: 'string' }, // 无 default 不注入
          },
        } as never,
      }],
    };
    registry.register(m, TestProvider);
    configs[0]!.impls = { 'bug-impl': { order: 1 } };
    const providers = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint);
    expect(providers[0]!.cfg).toMatchObject({ query_truncate: 8000 });
    expect((providers[0]!.cfg as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('BUG-003：default 底座被 ScopeConfig.impls[].configValues 覆盖', () => {
    const m: PluginManifest = {
      id: 'p-bug003b',
      extImpls: [{
        implId: 'bug-impl2',
        point: 'llm_provider',
        impl: './bug-impl2.ts',
        configSchema: {
          type: 'object',
          properties: { query_truncate: { type: 'number', default: 8000 } },
        } as never,
      }],
    };
    registry.register(m, TestProvider);
    configs[0]!.impls = { 'bug-impl2': { order: 1, configValues: { query_truncate: 4000 } } };
    const providers = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint);
    expect(providers[0]!.cfg).toMatchObject({ query_truncate: 4000 });
  });
});

describe('PluginManager.getExtensionImpls — list cardinality 形状', () => {
  it('list 点全返 active（按 membership）', () => {
    regManifest('p1', [
      { implId: 'a', point: 'llm_provider' },
      { implId: 'b', point: 'llm_protocol' },
    ]);
    configs[0]!.impls = { a: { order: 1 }, b: { order: 1 } };
    const m = rebuild();
    expect(m.getExtensionImpls(LlmProviderPoint)).toHaveLength(1);
    expect(m.getExtensionImpls(LlmProtocolPoint)).toHaveLength(1);
  });
});

/**
 * BUG-PLUGIN-004 回归：instantiate 改 deepMerge 后，嵌套 object 不再被整体替换。
 * 参考: specs/research/v0.0.71-bug-plugin-004-config-merge.md §6（要补的 case）
 *
 * 覆盖：
 *   - 嵌套 object deepMerge：default 子字段 + configValues 子字段 递归合并
 *   - configValues 显式 undefined 不覆盖 default（deepMerge 语义）
 */
describe('BUG-PLUGIN-004：deepMerge 嵌套 object 不丢字段', () => {
  it('configSchema.default 嵌套 object + configValues 部分覆盖 → 递归合并', () => {
    // 场景：plugin 嵌套 credentials 对象（仿 resolve-provider-config 的 credentials 用例）
    // default = { credentials: { key: 'default-key', header: 'default-header' } }
    // configValues = { credentials: { key: 'override-key' } }
    // 浅 merge 会丢 header；deepMerge 应保留 header + 覆盖 key
    const m: PluginManifest = {
      id: 'p-bug004-nested',
      extImpls: [{
        implId: 'bug-004-nested',
        point: 'llm_provider',
        impl: './bug-004-nested.ts',
        configSchema: {
          type: 'object',
          properties: {
            credentials: {
              type: 'object',
              default: { key: 'default-key', header: 'default-header' },
            },
          },
        } as never,
      }],
    };
    registry.register(m, TestProvider);
    configs[0]!.impls = {
      'bug-004-nested': { configValues: { credentials: { key: 'override-key' } } },
    };
    const providers = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint);
    // deepMerge 递归合并：header 保留 default，key 被 configValues 覆盖
    expect(providers[0]!.cfg).toMatchObject({
      credentials: { key: 'override-key', header: 'default-header' },
    });
  });

  it('configValues 显式 undefined 不覆盖 default（deepMerge 语义）', () => {
    // 场景：default 提供 query_truncate=8000；configValues 显式 { query_truncate: undefined }
    // spread 浅 merge 会把 query_truncate 设为 undefined（覆盖 default）
    // deepMerge 跳过 undefined（保留 default 8000），契约对齐 resolve-provider-config
    const m: PluginManifest = {
      id: 'p-bug004-undef',
      extImpls: [{
        implId: 'bug-004-undef',
        point: 'llm_provider',
        impl: './bug-004-undef.ts',
        configSchema: {
          type: 'object',
          properties: {
            query_truncate: { type: 'number', default: 8000 },
          },
        } as never,
      }],
    };
    registry.register(m, TestProvider);
    configs[0]!.impls = {
      'bug-004-undef': {
        // 显式 undefined（反模式但需明确契约）
        configValues: { query_truncate: undefined },
      },
    };
    const providers = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint);
    // deepMerge 跳过 undefined → default 保留
    expect(providers[0]!.cfg).toMatchObject({ query_truncate: 8000 });
  });
});
