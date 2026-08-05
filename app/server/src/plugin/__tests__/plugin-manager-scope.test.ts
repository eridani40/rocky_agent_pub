/**
 * PluginManager 单测（v0.0.179 membership 模型）— getExtensionImpls 双重载 + per-EP 回退
 * 参考: specs/tech/config/[P0]ext_impl_scope.md §5（F4 per-EP 回退）
 *
 * v0.0.179 模型简化（impl 列表模型）：
 *   - 读源 ScopeConfigProvider（代码声明）
 *   - membership active：key 在 impls 字典 = active；不在 = inactive（不再 cfg?.enabled ?? true）
 *   - per-EP 回退：非 default scope 的 activatedPoints 含 EP → 取 scope 配置；否则 → 取 default
 *   - v0.0.206（plugin scope D6 已删）：default 无特权——激活=point 节点在 yaml 声明，不配=关
 *
 * 覆盖：
 *   - resolveScopeSource helper：default 直返 default（extends 链 root）；非 default 激活→scopeId；未激活→'default'
 *   - 单参 ≡ 双参 default（向后兼容）
 *   - per-EP 回退：未激活 EP 取 default，激活 EP 取 scope
 *   - snapshot 隔离：custom 视图独立于 default（代码声明天然隔离，每 scope 独立 ScopeConfig）
 *   - v0.0.206 新语义：isPointActivated(default, 未声明EP)=false；listActivatedPoints(default)=yaml 声明集
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { Registry } from '../registry';
import { PluginManager } from '../plugin-manager';
import { LoadedScopeConfigProvider } from '../scope-config-provider';
import type { ScopeConfig } from '../scope-config-loader';
import { LlmProviderPoint } from '../extension-point';
import type { PluginManifest, ExtImpl } from '../manifest';

let registry: Registry;
let configs: ScopeConfig[];
let mgr: PluginManager;

beforeEach(() => {
  registry = new Registry();
  registry.registerExtensionPoint(LlmProviderPoint);
  configs = [
    { scopeId: 'default', name: 'Default', activatedPoints: [], impls: {} },
  ];
});

function rebuild(): PluginManager {
  mgr = new PluginManager({ registry, scopeConfigs: new LoadedScopeConfigProvider(configs) });
  return mgr;
}

class TestProvider {
  implId: string;
  cfg: unknown;
  constructor(implId: string, cfg: unknown) {
    this.implId = implId;
    this.cfg = cfg;
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
  registry.register(m, ...extImpls.map(() => TestProvider));
}

describe('resolveScopeSource — per-EP 回退取源 helper（spec §5.2）', () => {
  it('scopeId=default 直返 default（extends 链 root，不查 activatedPoints）', () => {
    configs[0]!.activatedPoints = ['llm_provider']; // default 列了 activatedPoints，仍走 default
    expect(rebuild().resolveScopeSource('default', 'llm_provider')).toBe('default');
  });

  it('非 default 未激活 → 回退 default', () => {
    configs.push({ scopeId: 'custom', name: 'C', activatedPoints: [], impls: {} });
    expect(rebuild().resolveScopeSource('custom', 'llm_provider')).toBe('default');
  });

  it('非 default 激活 → 返 scopeId（按 pointId 粒度）', () => {
    configs.push({
      scopeId: 'custom', name: 'C',
      activatedPoints: ['llm_provider'],
      impls: {},
    });
    const m = rebuild();
    expect(m.resolveScopeSource('custom', 'llm_provider')).toBe('custom');
    expect(m.resolveScopeSource('custom', 'other_point')).toBe('default');
  });

  it('未声明 custom scope → throw（v0.0.204 bug fix：不静默兜底 default，防 summary/consolidate 递归）', () => {
    expect(() => rebuild().resolveScopeSource('undeclared', 'llm_provider')).toThrow(
      /unregistered scopeId "undeclared"/,
    );
  });
});

describe('getExtensionImpls 双重载 — TS 签名 + 向后兼容', () => {
  it('单参 ≡ 双参 default：行为完全一致（向后兼容现有调用方零改动）', () => {
    regManifest('p1', [
      { implId: 'a', point: 'llm_provider' },
      { implId: 'b', point: 'llm_provider' },
    ]);
    // v0.0.179：default 只列 b（a 不在 = inactive）
    configs[0]!.impls = { b: { order: 1 } };
    const m = rebuild();
    const r1 = m.getExtensionImpls<TestProvider>(LlmProviderPoint);
    const r2 = m.getExtensionImpls<TestProvider>(LlmProviderPoint, 'default');
    expect(r1.map((p) => p.implId)).toEqual(r2.map((p) => p.implId));
    expect(r1.map((p) => p.implId).sort()).toEqual(['b']);
  });
});

describe('default scope 取源（v0.0.206：default 无特权，plugin scope D6 已删）', () => {
  it('default scope 直接读 default 配置（取源=default，impl active 看 membership）', () => {
    regManifest('p1', [{ implId: 'a', point: 'llm_provider' }]);
    // v0.0.179：default 不列 a → inactive
    configs[0]!.impls = {};
    configs[0]!.activatedPoints = []; // default 不列 activatedPoints
    const m = rebuild();
    // default 取源仍是 default，但 a 不在 default impls → 返空
    expect(m.getExtensionImpls(LlmProviderPoint, 'default')).toHaveLength(0);
    expect(m.getExtensionImpls(LlmProviderPoint)).toHaveLength(0); // 单参同
  });
});

describe('per-EP 回退（PRD P3/P4）— 未激活 EP 取 default，激活 EP 取 scope', () => {
  it('未激活 EP：取 default 配置（≡ getExtensionImpls(point)）', () => {
    regManifest('p1', [{ implId: 'a', point: 'llm_provider' }]);
    // v0.0.179：default 不列 a → inactive
    configs[0]!.impls = {};
    configs.push({ scopeId: 'custom', name: 'C', activatedPoints: [], impls: {} });
    // custom 未激活此 EP → 回退 default → a 不在 → 0 个
    expect(rebuild().getExtensionImpls(LlmProviderPoint, 'custom')).toHaveLength(0);
  });

  it('激活 EP：取 custom 自己的配置（与 default 独立）', () => {
    regManifest('p1', [{ implId: 'a', point: 'llm_provider' }]);
    // v0.0.179：default 不列 a；custom 列 a（membership active）
    configs[0]!.impls = {};
    configs.push({
      scopeId: 'custom', name: 'C',
      activatedPoints: ['llm_provider'], impls: { a: { order: 1 } },
    });
    // custom 激活此 EP → 取 custom 配置（a 在 → active） → 1 个
    expect(rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint, 'custom'))
      .toHaveLength(1);
  });

  it('per-EP 粒度：激活某 EP 不影响其他 EP（其他 EP 仍回退 default）', () => {
    regManifest('p1', [{ implId: 'a', point: 'llm_provider' }]);
    configs.push({
      scopeId: 'custom', name: 'C',
      activatedPoints: ['llm_provider'], impls: { a: { order: 1 } },
    });
    const m = rebuild();
    expect(m.getExtensionImpls(LlmProviderPoint, 'custom')).toHaveLength(1);
    expect(m.resolveScopeSource('custom', 'other_point')).toBe('default');
  });
});

describe('snapshot 隔离（UC-F3-1）— 每 scope 独立 ScopeConfig（天然隔离）', () => {
  it('custom/default 同 EP 各自独立（代码声明 per-scope 一份，互不干扰）', () => {
    regManifest('p1', [{ implId: 'a', point: 'llm_provider' }]);
    // v0.0.179：default 不列 a；custom 列 a（membership active）
    configs[0]!.impls = {};
    configs.push({
      scopeId: 'custom', name: 'C',
      activatedPoints: ['llm_provider'],
      impls: { a: { order: 1 } },
    });
    const m = rebuild();
    // custom 视图：a 在 → active
    expect(m.getExtensionImpls<TestProvider>(LlmProviderPoint, 'custom')).toHaveLength(1);
    // default 视图：a 不在 → inactive
    expect(m.getExtensionImpls(LlmProviderPoint, 'default')).toHaveLength(0);
  });
});

describe('cardinality 复用 — 算法不变，仅源按 scope', () => {
  it('list：未激活 EP → 回退 default 配置', () => {
    regManifest('p1', [
      { implId: 'a', point: 'llm_provider' },
      { implId: 'b', point: 'llm_provider' },
    ]);
    // v0.0.179：default 列 b（a 不在 = inactive）
    configs[0]!.impls = { b: { order: 1 } };
    configs.push({ scopeId: 'custom', name: 'C', activatedPoints: [], impls: {} });
    // custom 未激活 → 回退 default → a 不在 → 仅 b
    const r = rebuild().getExtensionImpls<TestProvider>(LlmProviderPoint, 'custom');
    expect(r.map((p) => p.implId)).toEqual(['b']);
  });
});

describe('LoadedScopeConfigProvider — v0.0.206 新语义（default 无特权，plugin scope D6 已删）', () => {
  it('isPointActivated(default, 未声明 EP) === false（default 不配 = 关）', () => {
    const p = new LoadedScopeConfigProvider([
      { scopeId: 'default', name: 'Default', activatedPoints: ['llm_provider'], impls: {} },
    ]);
    expect(p.isPointActivated('default', 'llm_provider')).toBe(true);
    expect(p.isPointActivated('default', 'undeclared_ep')).toBe(false);
  });

  it('listActivatedPoints(default) 只返 yaml 声明集（不再返全 registry EP）', () => {
    const p = new LoadedScopeConfigProvider([
      { scopeId: 'default', name: 'Default', activatedPoints: ['llm_provider'], impls: {} },
    ]);
    expect(p.listActivatedPoints('default')).toEqual(['llm_provider']);
  });
});
