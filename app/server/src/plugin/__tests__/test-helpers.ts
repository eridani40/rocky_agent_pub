/**
 * test-helpers — v0.0.67 plugin UT 共享 builder：构造 ScopeConfigProvider / PluginManager / PluginConfigService
 *
 * UT 在 v0.0.67 重构后必须经代码声明（ScopeConfig[]）注入 PluginManager/PluginConfigService，
 * 不再直接 PluginPolicyStore 落盘驱动。本 helper 提供 in-memory ScopeConfig 构造便利，
 * 让 UT 用最少 boilerplate 表达「这个 scope 下这些 impl 怎么配置」。
 *
 * v0.0.71：PluginConfigService constructor 加 groupMeta 必填参数（D1+D3 嵌套 inventory）。
 * 本 helper 提供 auto-derive 默认（把 registry 全部 EP 包进一个合成 group "default"），
 * 让不关心 group 结构的 UT 零 boilerplate 跑通；关心 group 的 UT 可显式传 groupMeta。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Registry } from '../registry';
import { PluginManager } from '../plugin-manager';
import { PluginConfigService } from '../plugin-config-service';
import {
  LoadedScopeConfigProvider,
  type ScopeConfigProvider,
} from '../scope-config-provider';
import {
  LoadedGroupMetaProvider,
  type GroupMetaProvider,
} from '../group-meta-provider';
import type { GroupMeta } from '../group-meta-loader';
import type { ScopeConfig, ScopeImplConfig } from '../scope-config-loader';

/** 默认 default scope（空 activatedPoints/impls；UT 可在此基础上扩展） */
export function makeDefaultScope(overrides: Partial<ScopeConfig> = {}): ScopeConfig {
  return {
    scopeId: 'default',
    name: 'Default',
    description: '',
    activatedPoints: [],
    impls: {},
    ...overrides,
  };
}

/** 构造单条 impl 配置（语法糖） */
export function implCfg(cfg: ScopeImplConfig): ScopeImplConfig {
  return cfg;
}

/** 从 inline ScopeConfig[] 构造 Provider（UT 主入口） */
export function makeProvider(configs: ScopeConfig[]): ScopeConfigProvider {
  return new LoadedScopeConfigProvider(configs);
}

/**
 * v0.0.71：从 registry 已登记的 EP 自动构造合成 GroupMetaProvider（单 group "default" 包含全部 EP）。
 * 用于不关心 group 结构的 UT（如写路径删 / handler 形状 / plugins[] 字段）零 boilerplate 跑通。
 * 关心 group 嵌套结构的 UT 应直接 new LoadedGroupMetaProvider(groupMetas) 显式注入。
 */
export function makeAutoGroupMeta(registry: Registry): GroupMetaProvider {
  const synthetic: GroupMeta = {
    id: 'default',
    label: '__MSG_group.default.label__',
    description: '__MSG_group.default.description__',
    extPoints: registry.listPoints(),
  };
  return new LoadedGroupMetaProvider([synthetic]);
}

/**
 * 构造 PluginManager（默认 + custom scope，inline 配置）。
 * 用法：
 *   const mgr = makeManager(registry, [
 *     makeDefaultScope({ activatedPoints: ['llm_provider'] }),
 *     { scopeId: 'custom', name: 'C', activatedPoints: [...], impls: {...} },
 *   ]);
 */
export function makeManager(registry: Registry, configs: ScopeConfig[]): PluginManager {
  return new PluginManager({ registry, scopeConfigs: makeProvider(configs) });
}

/**
 * 构造 PluginConfigService（默认 + custom scope）。root 用 tmpdir（写路径落盘 lazy migrate）。
 * v0.0.71：groupMeta 默认从 registry auto-derive（不关心 group 结构的 UT 用默认）。
 */
export function makeConfigService(
  registry: Registry,
  configs: ScopeConfig[],
  groupMeta?: GroupMetaProvider,
): { svc: PluginConfigService; tmpRoot: string } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-test-'));
  const svc = new PluginConfigService(registry, {
    root: tmpRoot,
    scopeConfigs: makeProvider(configs),
    groupMeta: groupMeta ?? makeAutoGroupMeta(registry),
  });
  return { svc, tmpRoot };
}

/** 构造 PluginManager + PluginConfigService 共享同一 Provider + tmpRoot（集成测试用） */
export function makeStack(
  registry: Registry,
  configs: ScopeConfig[],
  groupMeta?: GroupMetaProvider,
): { mgr: PluginManager; svc: PluginConfigService; tmpRoot: string } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-test-'));
  const provider = makeProvider(configs);
  const mgr = new PluginManager({ registry, scopeConfigs: provider });
  const svc = new PluginConfigService(registry, {
    root: tmpRoot,
    scopeConfigs: provider,
    groupMeta: groupMeta ?? makeAutoGroupMeta(registry),
  });
  return { mgr, svc, tmpRoot };
}

/** 清理 tmpRoot（afterEach 调） */
export function cleanupTmpRoot(tmpRoot: string): void {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

/**
 * 拍平嵌套 groups[].points[].impls[] → 单一 impl 数组（v0.0.71 D3 嵌套化适配）。
 *
 * UT 在 v0.0.71 后 inventory 形状改嵌套，但很多聚合断言（如「所有 impl enabled」）只需 impl 数组；
 * 本辅助把这些 case 从嵌套迭代细节解耦，断言语义不丢。
 *
 * @example
 *   const flat = flattenImpls(tree.groups);
 *   expect(flat.every((e) => e.enabled === true)).toBe(true);
 */
export function flattenImpls<
  T extends { pluginId: string; implId: string; pointId: string },
>(groups: { points: { impls: T[] }[] }[]): T[] {
  const out: T[] = [];
  for (const g of groups) {
    for (const p of g.points) {
      for (const i of p.impls) out.push(i);
    }
  }
  return out;
}
