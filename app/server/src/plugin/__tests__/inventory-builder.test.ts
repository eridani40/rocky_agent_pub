/**
 * inventory-builder 单测（白盒）— v0.0.71 D3 嵌套结构 + 声明序 + 排序 + per-EP 回退
 * 参考: specs/tech/version_logs/v0.0.71/change_plan.md 模块 5（D3 嵌套化）
 *       specs/api/version_logs/v0.0.71.md（AFTER 嵌套形状 = 断言契约源）
 *
 * 覆盖：
 *   1. 嵌套结构 groups[].points[].impls[] 三层（不再有顶层 extImpls[]）
 *   2. groups 顺序 = GroupMetaProvider.listGroups() 声明序（D5）
 *   3. point 内 impl 排序 = effective order + (pluginId, implId) 稳定尾序
 *   4. per-EP 回退（forked 未激活 EP → default 视图，UI 灰显）
 *
 * 关联文件：
 *   - inventory-builder-bug-a.test.ts（bug-A JOIN default：compactRatio=0.6 等）
 *   - inventory-builder-d7-flagged.test.ts（D7 透传 configSchema + flagged ② 并集口径 + D6 防御）
 */
import { describe, it, expect } from 'vitest';
import { buildGroups, type InventoryBuilderDeps } from '../inventory-builder';
import { Registry } from '../registry';
import type { ExtensionPoint } from '../extension-point';
import type { PluginManifest, ExtImpl } from '../manifest';
import type { ScopeConfig } from '../scope-config-loader';
import { LoadedScopeConfigProvider } from '../scope-config-provider';
import { LoadedGroupMetaProvider, type GroupMetaProvider } from '../group-meta-provider';
import type { GroupMeta } from '../group-meta-loader';

// ── 测试 fixtures ────────────────────────────────────────────────────────────

/** 测试用 EP（cardinality 可配） */
function mkPoint(id: string, cardinality: 'exclusive' | 'list' | 'ordered'): ExtensionPoint {
  return { id, cardinality, description: `EP ${id}` } as unknown as ExtensionPoint;
}

/** 注册单个 plugin（带 ext impls，可配 configSchema/description） */
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

/** 测试 group 元数据构造器（按需声明 group + extPoints，UT 不强制全集） */
function mkGroup(id: string, extPoints: string[]): GroupMeta {
  const snake = id.replace(/-/g, '_');
  return {
    id,
    label: `__MSG_group.${snake}.label__`,
    description: `__MSG_group.${snake}.description__`,
    extPoints,
  };
}

/** 默认 group 元数据（4 EP 分 2 group，UT 按需挑子集） */
function testGroupMetas(): GroupMeta[] {
  return [
    mkGroup('context-compact', ['context_should_compact', 'context_do_compact']),
    mkGroup('provider', ['llm_provider', 'llm_protocol']),
  ];
}

/** 构造测试 deps（registry + scopeConfigs + groupMeta） */
function makeDeps(
  registry: Registry,
  configs: ScopeConfig[],
  metas: GroupMeta[] = testGroupMetas(),
): InventoryBuilderDeps {
  return {
    registry,
    scopeConfigs: new LoadedScopeConfigProvider(configs),
    groupMeta: new LoadedGroupMetaProvider(metas) as GroupMetaProvider,
  };
}

/** 默认 default scope（语法糖） */
function defaultScope(overrides: Partial<ScopeConfig> = {}): ScopeConfig {
  return {
    scopeId: 'default',
    name: 'Default',
    activatedPoints: [],
    impls: {},
    ...overrides,
  };
}

// ── 测试用例 ────────────────────────────────────────────────────────────────

describe('buildGroups — v0.0.71 D3 嵌套结构 + 声明序 + 排序', () => {
  it('嵌套 groups[].points[].impls[] 三层（不再有顶层 extImpls[]）', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('context_should_compact', 'exclusive'));
    registry.registerExtensionPoint(mkPoint('context_do_compact', 'ordered'));
    registerPlugin(registry, 'rocky_context', [
      { implId: 'threshold_should_compact', point: 'context_should_compact' },
      { implId: 'summary_do_compact', point: 'context_do_compact' },
    ]);
    const deps = makeDeps(
      registry,
      // v0.0.206：default 无特权（plugin scope D6 已删），activated 依赖 yaml 声明 → fixture 补声明
      [defaultScope({ activatedPoints: ['context_should_compact', 'context_do_compact'] })],
      [mkGroup('context-compact', ['context_should_compact', 'context_do_compact'])],
    );

    const groups = buildGroups(deps, 'default');

    // 顶层结构：groupId + points[]（不再有 extImpls[]）
    expect(groups.length).toBe(1);
    expect(groups[0]!.groupId).toBe('context-compact');
    // groups[].points[] 存在（嵌套层）
    expect(groups[0]!.points).toBeInstanceOf(Array);
    // 顶层不再有 extImpls[]（API spec §3.1：删除）
    expect((groups[0] as unknown as { extImpls?: unknown }).extImpls).toBeUndefined();

    // 嵌套层：points[].impls[]
    const compactGroup = groups[0]!;
    expect(compactGroup.points.length).toBe(2); // context_should_compact + context_do_compact
    const shouldCompactPoint = compactGroup.points.find(
      (p) => p.pointId === 'context_should_compact',
    )!;
    expect(shouldCompactPoint.activated).toBe(true); // default yaml 声明此 EP = 激活（v0.0.206）
    expect(shouldCompactPoint.impls).toBeInstanceOf(Array);
    expect(shouldCompactPoint.impls.length).toBe(1);
    expect(shouldCompactPoint.impls[0]!.implId).toBe('threshold_should_compact');
  });

  it('groups 顺序 = GroupMetaProvider.listGroups() 声明序（不按 registry 注册序）', () => {
    const registry = new Registry();
    // registry 注册序：先 llm_provider 后 context_should_compact（与 group 声明序反）
    registry.registerExtensionPoint(mkPoint('llm_provider', 'exclusive'));
    registry.registerExtensionPoint(mkPoint('llm_protocol', 'list'));
    registry.registerExtensionPoint(mkPoint('context_should_compact', 'exclusive'));
    registerPlugin(registry, 'p1', [
      { implId: 'llm_p', point: 'llm_provider' },
      { implId: 'llm_proto', point: 'llm_protocol' },
      { implId: 'compact', point: 'context_should_compact' },
    ]);
    const deps = makeDeps(
      registry,
      [defaultScope()],
      // groupMetas 声明序：context-compact 在前，provider 在后
      [
        mkGroup('context-compact', ['context_should_compact']),
        mkGroup('provider', ['llm_provider', 'llm_protocol']),
      ],
    );

    const groups = buildGroups(deps, 'default');
    // 顺序按 groupMetas 声明：context-compact 在前（声明序），provider 在后——
    // 即使 registry 注册序是 provider 在前
    expect(groups.map((g) => g.groupId)).toEqual(['context-compact', 'provider']);
  });

  it('point 内 impl 排序：effective order 升序 + (pluginId, implId) 稳定尾序', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('context_do_compact', 'ordered'));
    // 注册 3 个 impl，同 point（ordered cardinality）
    registerPlugin(registry, 'pluginA', [
      { implId: 'impl_z', point: 'context_do_compact' },
      { implId: 'impl_a', point: 'context_do_compact' },
    ]);
    registerPlugin(registry, 'pluginB', [
      { implId: 'impl_m', point: 'context_do_compact' },
    ]);
    const deps = makeDeps(
      registry,
      [
        defaultScope({
          impls: {
            // 显式声明 order：impl_z=2, impl_a=1, impl_m=3 → 排序后 impl_a, impl_z, impl_m
            impl_z: { order: 2 },
            impl_a: { order: 1 },
            impl_m: { order: 3 },
          },
        }),
      ],
      [mkGroup('context-compact', ['context_do_compact'])],
    );

    const groups = buildGroups(deps, 'default');
    const compactPoint = groups[0]!.points.find((p) => p.pointId === 'context_do_compact')!;
    const implOrder = compactPoint.impls.map((i) => i.implId);
    // effective order 升序：impl_a(1) < impl_z(2) < impl_m(3)
    expect(implOrder).toEqual(['impl_a', 'impl_z', 'impl_m']);
  });
});

describe('buildGroups — per-EP 回退（forked 未激活 EP → default 视图）', () => {
  it('forked scope 未激活 EP：points[].activated=false，impls 仍序列化（取 default 视图）', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('context_should_compact', 'exclusive'));
    registry.registerExtensionPoint(mkPoint('llm_provider', 'exclusive'));
    registerPlugin(registry, 'rocky_context', [
      { implId: 'threshold', point: 'context_should_compact' },
    ]);
    registerPlugin(registry, 'mock-llm', [
      { implId: 'mock', point: 'llm_provider' },
    ]);
    // forked scope 仅激活 context_should_compact（不激活 llm_provider）
    const deps = makeDeps(
      registry,
      [
        {
          scopeId: 'forked',
          name: 'Forked',
          activatedPoints: ['context_should_compact'],
          impls: {},
        },
        defaultScope(),
      ],
      [
        mkGroup('context-compact', ['context_should_compact']),
        mkGroup('provider', ['llm_provider']),
      ],
    );

    const groups = buildGroups(deps, 'forked');
    const compactPoint = groups.find((g) => g.groupId === 'context-compact')!
      .points.find((p) => p.pointId === 'context_should_compact')!;
    const providerPoint = groups.find((g) => g.groupId === 'provider')!
      .points.find((p) => p.pointId === 'llm_provider')!;
    // forked 激活的 EP：activated=true
    expect(compactPoint.activated).toBe(true);
    // forked 未激活的 EP：activated=false，但 impls 仍序列化（取 default 视图，UI 灰显）
    expect(providerPoint.activated).toBe(false);
    expect(providerPoint.impls.length).toBe(1); // 取 default 视图（不静默隐藏）
  });
});
