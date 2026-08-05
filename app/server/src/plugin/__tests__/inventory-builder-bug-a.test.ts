/**
 * inventory-builder 单测（白盒）— v0.0.71 bug-A JOIN default
 * 参考: specs/tech/version_logs/v0.0.71/change_plan.md 模块 5（bug-A 行）
 *       specs/api/version_logs/v0.0.71.md §3.2（config 字段行为变更）
 *
 * bug-A 背景：
 *   - v0.0.71 前：ExtImplNode.config = implCfg?.configValues（裸 configValues）
 *     → default.json 未声明 configValues 时 config=undefined（用户「config 不丢」诉求未达）
 *   - v0.0.71 修复：config = JOIN(extractConfigDefaults(configSchema) ⊕ implCfg.configValues)
 *     manifest default 底座 ⊕ scope configValues overlay（per-domain 默认表对齐 spec）
 *
 * 关联文件：
 *   - inventory-builder.test.ts（D3 嵌套结构 + 排序 + per-EP 回退）
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

// ── 测试用例 ────────────────────────────────────────────────────────────────

describe('buildGroups — bug-A JOIN default（change_plan 模块 5）', () => {
  it('config 字段 = JOIN(manifest default ⊕ scope configValues)：compactRatio=0.6 在 scope 未声明时可见', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('context_should_compact', 'exclusive'));
    registerPlugin(registry, 'rocky_context', [
      {
        implId: 'threshold_should_compact',
        point: 'context_should_compact',
        configSchema: {
          type: 'object',
          properties: {
            compactRatio: {
              type: 'number',
              default: 0.6,
              description: '__MSG_impl.threshold_should_compact.compactRatio.description__',
            },
            maxMessages: {
              type: 'number',
              default: 100,
            },
          },
        },
      },
    ]);
    // v0.0.179：default scope 列出 threshold_should_compact（active）但不声明 configValues（bug-A 场景）
    const deps = makeDeps(
      registry,
      [defaultScope({
        activatedPoints: ['context_should_compact'],
        impls: { threshold_should_compact: { order: 1 } },
      })],
      [mkGroup('context-compact', ['context_should_compact'])],
    );

    const groups = buildGroups(deps, 'default');
    const node = groups[0]!.points[0]!.impls[0]!;
    // bug-A：config.compactRatio=0.6 在 scope configValues 未声明时也可见（manifest default 底座）
    expect(node.config.compactRatio).toBe(0.6);
    expect(node.config.maxMessages).toBe(100);
  });

  it('scope configValues overlay 覆盖 manifest default（同 key）', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('context_should_compact', 'exclusive'));
    registerPlugin(registry, 'rocky_context', [
      {
        implId: 'threshold_should_compact',
        point: 'context_should_compact',
        configSchema: {
          type: 'object',
          properties: {
            compactRatio: { type: 'number', default: 0.6 },
          },
        },
      },
    ]);
    // forked scope 显式覆盖 compactRatio=0.8（覆盖 manifest default）
    const deps = makeDeps(
      registry,
      [
        defaultScope({
          impls: {
            threshold_should_compact: { configValues: { compactRatio: 0.8 } },
          },
        }),
      ],
      [mkGroup('context-compact', ['context_should_compact'])],
    );

    const groups = buildGroups(deps, 'default');
    const node = groups[0]!.points[0]!.impls[0]!;
    // scope configValues overlay 覆盖 manifest default
    expect(node.config.compactRatio).toBe(0.8);
  });

  it('无 configSchema → config 为空对象（不抛错）', () => {
    const registry = new Registry();
    registry.registerExtensionPoint(mkPoint('llm_provider', 'exclusive'));
    registerPlugin(registry, 'mock-llm', [
      { implId: 'mock', point: 'llm_provider' }, // 无 configSchema
    ]);
    const deps = makeDeps(
      registry,
      // v0.0.179：mock impl 列在 impls（active）
      [defaultScope({
        activatedPoints: ['llm_provider'],
        impls: { mock: { order: 1 } },
      })],
      [mkGroup('provider', ['llm_provider'])],
    );

    const groups = buildGroups(deps, 'default');
    const node = groups.find((g) => g.groupId === 'provider')!
      .points.find((p) => p.pointId === 'llm_provider')!
      .impls[0]!;
    // 无 configSchema → config = {}（不抛错，不 undefined）
    expect(node.config).toEqual({});
  });
});
