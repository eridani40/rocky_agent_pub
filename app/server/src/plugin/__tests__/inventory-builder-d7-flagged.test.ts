/**
 * inventory-builder 单测（白盒）— v0.0.71 D7 透传 configSchema + flagged ② 并集口径 + D6 防御
 * 参考: specs/tech/version_logs/v0.0.71/change_plan.md 模块 5（D7 + flagged ②）
 *       specs/api/version_logs/v0.0.71.md §3.2（字段 BEFORE/AFTER）
 *
 * 覆盖：
 *   1. D7 加：ExtImplNode.configSchema 透传 manifest configSchema（让前端 modal 读 JSON Schema）
 *   2. D7 删：ExtImplNode.schemaConfig 字段移除（单一 schema 源）
 *   3. API spec §3.2：ExtImplNode.pointActivated 字段移除（信息上提到 points[].activated）
 *   4. flagged ②：forked scope disabled exclusive 候选并集口径
 *      （absent ∪ enabled:false 都接受；inventory 不静默 fallback）
 *   5. D6 不变量防御：groups.json 引用未注册 EP → throw（不静默 fallback）
 *
 * 关联文件：
 *   - inventory-builder.test.ts（D3 嵌套结构 + 排序 + per-EP 回退）
 *   - inventory-builder-bug-a.test.ts（bug-A JOIN default：compactRatio=0.6 等）
 */
import { describe, it, expect } from 'vitest';
import { buildGroups, type InventoryBuilderDeps, type ExtImplNode } from '../inventory-builder';
import { Registry } from '../registry';
import type { ExtensionPoint } from '../extension-point';
import type { PluginManifest, ExtImpl } from '../manifest';
import type { ScopeConfig } from '../scope-config-loader';
import { LoadedScopeConfigProvider } from '../scope-config-provider';
import { LoadedGroupMetaProvider, type GroupMetaProvider } from '../group-meta-provider';
import type { GroupMeta } from '../group-meta-loader';

// ── 测试 fixtures（与 inventory-builder.test.ts 同型，独立便于本文件单跑） ─────

function mkPoint(id: string, cardinality: 'exclusive' | 'list' | 'ordered'): ExtensionPoint {
  return { id, cardinality, description: `EP ${id}` } as unknown as ExtensionPoint;
}

function registerPlugin(
  registry: Registry,
  pluginId: string,
  extImpls: Array<{
    implId: string;
    point: string;
    description?: string;
    configSchema?: Record<string, unknown>;
  }>,
): void {
  const full: ExtImpl[] = extImpls.map((e) => ({
    implId: e.implId,
    point: e.point,
    impl: `./${e.implId}.ts`,
    description: e.description,
    configSchema: e.configSchema,
  }));
  const manifest: PluginManifest = {
    id: pluginId,
    extImpls: full,
    description: `plugin ${pluginId}`,
  };
  const classes = extImpls.map(() => class {});
  registry.register(manifest, ...classes);
}

function mkGroup(id: string, extPoints: string[]): GroupMeta {
  const snake = id.replace(/-/g, '_');
  return {
    id,
    label: `__MSG_group.${snake}.label__`,
    description: `__MSG_group.${snake}.description__`,
    extPoints,
  };
}

function makeDeps(
  registry: Registry,
  configs: ScopeConfig[],
  metas: GroupMeta[],
): InventoryBuilderDeps {
  return {
    registry,
    scopeConfigs: new LoadedScopeConfigProvider(configs),
    groupMeta: new LoadedGroupMetaProvider(metas) as GroupMetaProvider,
  };
}

function defaultScope(overrides: Partial<ScopeConfig> = {}): ScopeConfig {
  return {
    scopeId: 'default',
    name: 'Default',
    activatedPoints: [],
    impls: {},
    ...overrides,
  };
}

// ── 测试用例：D7 透传 configSchema + 删 schemaConfig + 删 pointActivated ──────

describe('buildGroups — D7 透传 configSchema + 删 schemaConfig', () => {
  it('D7 加：ExtImplNode.configSchema 透传 manifest configSchema', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('context_should_compact', 'exclusive'));
    const configSchema = {
      type: 'object',
      properties: { compactRatio: { type: 'number', default: 0.6 } },
    };
    registerPlugin(registry, 'rocky_context', [
      {
        implId: 'threshold_should_compact',
        point: 'context_should_compact',
        configSchema,
      },
    ]);
    const deps = makeDeps(
      registry,
      [defaultScope()],
      [mkGroup('context-compact', ['context_should_compact'])],
    );

    const groups = buildGroups(deps, 'default');
    const node = groups[0]!.points[0]!.impls[0]!;
    // D7：configSchema 透传（让前端 modal 读 JSON Schema 形状）
    expect(node.configSchema).toEqual(configSchema);
  });

  it('D7 删：ExtImplNode 不再有 schemaConfig 字段', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('context_should_compact', 'exclusive'));
    registerPlugin(registry, 'rocky_context', [
      { implId: 'threshold_should_compact', point: 'context_should_compact' },
    ]);
    const deps = makeDeps(
      registry,
      [defaultScope()],
      [mkGroup('context-compact', ['context_should_compact'])],
    );

    const groups = buildGroups(deps, 'default');
    const node = groups[0]!.points[0]!.impls[0]!;
    // D7：schemaConfig 字段已删（即使 manifest 仍声明也不透传——T4 后续删类型）
    expect((node as unknown as { schemaConfig?: unknown }).schemaConfig).toBeUndefined();
  });

  it('API spec §3.2 删：ExtImplNode 不再有 pointActivated（信息上提到 points[].activated）', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('context_should_compact', 'exclusive'));
    registerPlugin(registry, 'rocky_context', [
      { implId: 'threshold_should_compact', point: 'context_should_compact' },
    ]);
    const deps = makeDeps(
      registry,
      // v0.0.206：default 无特权（plugin scope D6 已删），activated 依赖 yaml 声明 → fixture 补声明
      [defaultScope({ activatedPoints: ['context_should_compact'] })],
      [mkGroup('context-compact', ['context_should_compact'])],
    );

    const groups = buildGroups(deps, 'default');
    const node = groups[0]!.points[0]!.impls[0]!;
    // API spec §3.2：pointActivated 字段已删（信息上提到 points[].activated）
    expect((node as unknown as { pointActivated?: unknown }).pointActivated).toBeUndefined();
    // 同时 points[].activated 仍可读到（同 point 共享）
    expect(groups[0]!.points[0]!.activated).toBe(true);
  });
});

// ── 测试用例：v0.0.179 forked scope membership 派生 enabled（flagged ② 并集口径）──

describe('buildGroups — v0.0.179 membership 派生 enabled/selected（forked scope）', () => {
  it('flagged ②：所有注册 impl 都序列化（active + inactive）；membership 决定 enabled', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('llm_provider', 'exclusive'));
    // 3 个 exclusive 候选：a (active)、b (inactive)、c (inactive)
    registerPlugin(registry, 'p1', [
      { implId: 'a', point: 'llm_provider' },
      { implId: 'b', point: 'llm_provider' },
      { implId: 'c', point: 'llm_provider' },
    ]);
    // v0.0.179 forked scope：a 在 impls（membership active）；b/c 不列（inactive）
    const deps = makeDeps(
      registry,
      [
        {
          scopeId: 'forked',
          name: 'Forked',
          activatedPoints: ['llm_provider'],
          impls: { a: { order: 1 } }, // 只 a active
        },
        defaultScope(),
      ],
      [mkGroup('provider', ['llm_provider'])],
    );

    const groups = buildGroups(deps, 'forked');
    const providerPoint = groups.find((g) => g.groupId === 'provider')!
      .points.find((p) => p.pointId === 'llm_provider')!;
    const implIds = providerPoint.impls.map((i: ExtImplNode) => i.implId).sort();
    // flagged ②：所有注册 impl 都序列化（inventory 不静默隐藏 inactive 候选，前端 radio 渲染「未选中」状态）
    expect(implIds).toEqual(['a', 'b', 'c']);

    // v0.0.179 enabled = membership：在 impls 字典 = true；不在 = false
    const nodeA = providerPoint.impls.find((i) => i.implId === 'a')!;
    const nodeB = providerPoint.impls.find((i) => i.implId === 'b')!;
    const nodeC = providerPoint.impls.find((i) => i.implId === 'c')!;
    expect(nodeA.enabled).toBe(true);  // 在 impls = active
    expect(nodeB.enabled).toBe(false); // 不在 = inactive
    expect(nodeC.enabled).toBe(false); // 不在 = inactive
  });

  it('exclusive selected 派生：active（membership）中 order 最小者（与运行时同口径）', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('llm_provider', 'exclusive'));
    registerPlugin(registry, 'p1', [
      { implId: 'a', point: 'llm_provider' },
      { implId: 'b', point: 'llm_provider' },
      { implId: 'c', point: 'llm_provider' },
    ]);
    // v0.0.179 forked scope：a/c 在 impls（active），b 不列（inactive）
    const deps = makeDeps(
      registry,
      [
        {
          scopeId: 'forked',
          name: 'Forked',
          activatedPoints: ['llm_provider'],
          impls: {
            a: { order: 1 },
            c: { order: 3 },
            // b 不在 = inactive
          },
        },
        defaultScope(),
      ],
      [mkGroup('provider', ['llm_provider'])],
    );

    const groups = buildGroups(deps, 'forked');
    const providerPoint = groups.find((g) => g.groupId === 'provider')!
      .points.find((p) => p.pointId === 'llm_provider')!;
    // exclusive selected = active（membership）中 effective order 最小者
    // a/c active (order 1/3)，b inactive → selected=a (order 1)
    const nodeA = providerPoint.impls.find((i) => i.implId === 'a')!;
    const nodeB = providerPoint.impls.find((i) => i.implId === 'b')!;
    const nodeC = providerPoint.impls.find((i) => i.implId === 'c')!;
    expect(nodeA.selected).toBe(true);
    expect(nodeB.selected).toBe(false);
    expect(nodeC.selected).toBe(false);
  });
});

// ── 测试用例：D6 不变量防御 ─────────────────────────────────────────────────

describe('buildGroups — D6 不变量防御', () => {
  it('groups.json 引用的 pointId 不在 registry → throw（不静默 fallback）', () => {
    const registry = new Registry();
    // 仅注册 context_should_compact（不注册 context_do_compact）
    registry.registerExtensionPoint(mkPoint('context_should_compact', 'exclusive'));
    registerPlugin(registry, 'p1', [
      { implId: 'threshold', point: 'context_should_compact' },
    ]);
    // 但 groupMetas 引用了 context_do_compact（misconfig）
    const deps = makeDeps(
      registry,
      [defaultScope()],
      [
        // 默认 testGroupMetas 含 context_do_compact（未注册）
        mkGroup('context-compact', ['context_should_compact', 'context_do_compact']),
      ],
    );

    // D6 不变量防御：buildGroups 不静默 fallback（启动期 validateGroups 兜底，但运行期也 throw）
    expect(() => buildGroups(deps, 'default')).toThrow(/context_do_compact/);
  });
});
