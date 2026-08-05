/**
 * PluginConfigService 单测（白盒）—— inventory group-centric JOIN（v0.0.67 起只读化）
 * 参考: specs/tech/config/[P0]plugin_config_service.md v2.1 §2/§3（inventory group-centric）
 *       reqs/[working] v0.0.67.plugin_config_refactor/design.md §3 D2/D4（写路径删）
 *
 * 设计（v0.0.67 重构后）：
 *   - 树存在性 100% 来自 registry 代码 + ScopeConfigProvider（不读落盘 policy）
 *   - 缺数据处填代码默认（enabled=true / order=末尾补位）
 *   - 写方法已删（用户指示「直接删写端点+写方法，无死代码」）；本测试覆盖 inventory 读路径 +
 *     断言写方法不存在（防回归）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Registry } from '../registry';
import { PluginConfigService } from '../plugin-config-service';
import {
  LlmProviderPoint,
  LlmProtocolPoint,
} from '../extension-point';
import { LoadedScopeConfigProvider } from '../scope-config-provider';
import { LoadedGroupMetaProvider } from '../group-meta-provider';
import { flattenImpls } from './test-helpers';
import type { PluginManifest, ExtImpl } from '../manifest';

let tmpRoot: string;
let registry: Registry;
let svc: PluginConfigService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cfg-'));
  registry = new Registry();
  registry.registerExtensionPoint(LlmProviderPoint);
  registry.registerExtensionPoint(LlmProtocolPoint);
  svc = new PluginConfigService(registry, {
    root: tmpRoot,
    scopeConfigs: new LoadedScopeConfigProvider([
      { scopeId: 'default', name: 'Default', activatedPoints: [], impls: {} },
    ]),
    // v0.0.71 D1：注入 groupMeta（llm_provider+llm_protocol → provider 单 group）
    groupMeta: new LoadedGroupMetaProvider([
      {
        id: 'provider',
        label: '__MSG_group.provider.label__',
        description: '__MSG_group.provider.description__',
        extPoints: ['llm_provider', 'llm_protocol'],
      },
    ]),
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

class P {}
class Q {}

function regPlugin(
  pluginId: string,
  extImpls: { implId: string; point: string }[],
): void {
  const full: ExtImpl[] = extImpls.map((e) => ({
    implId: e.implId,
    point: e.point,
    impl: './' + e.implId + '.ts',
  }));
  const m: PluginManifest = { id: pluginId, extImpls: full };
  const classes = extImpls.map((e) => (e.point === 'llm_provider' ? P : Q));
  registry.register(m, ...classes);
}

/**
 * v0.0.179 helper：用给定的 impls 字典重建 svc（membership 模型：key 在 = active）。
 * 让每条 inventory 用例显式表达「这个 scope 下哪些 impl active」，避免依赖默认语义。
 */
function withScopeImpls(impls: Record<string, { order?: number; configValues?: Record<string, unknown> }>): PluginConfigService {
  return new PluginConfigService(registry, {
    root: tmpRoot,
    scopeConfigs: new LoadedScopeConfigProvider([
      { scopeId: 'default', name: 'Default', activatedPoints: [], impls },
    ]),
    groupMeta: new LoadedGroupMetaProvider([
      {
        id: 'provider',
        label: '__MSG_group.provider.label__',
        description: '__MSG_group.provider.description__',
        extPoints: ['llm_provider', 'llm_protocol'],
      },
    ]),
  });
}

describe('PluginConfigService.inventory — group-centric：树来自 registry，缺数据填代码默认', () => {
  it('无 policy record → groups[] 带默认 pluginEnabled/enabled（v0.0.179 membership）', () => {
    regPlugin('p1', [
      { implId: 'a', point: 'llm_provider' },
      { implId: 'b', point: 'llm_protocol' },
    ]);
    // v0.0.179：scope 的 impls 字典列出 a/b（active）
    const tree = withScopeImpls({ a: { order: 1 }, b: { order: 1 } }).inventory();
    // v0.0.71 D3：嵌套 groups[].points[].impls[]（单 group provider 含 2 EP）
    expect(tree.groups).toHaveLength(1);
    const g = tree.groups[0]!;
    expect(g.groupId).toBe('provider');
    expect(g.points).toHaveLength(2); // llm_provider + llm_protocol
    const flat = flattenImpls(tree.groups);
    expect(flat).toHaveLength(2);
    expect(flat.every((e) => e.enabled === true)).toBe(true);
    expect(flat.every((e) => e.pluginEnabled === true)).toBe(true);
  });

  it('group-centric 聚合：同 group 的 ext impl 归同一组（llm_provider+llm_protocol → provider）', () => {
    regPlugin('p1', [
      { implId: 'anthropic_compatible', point: 'llm_provider' },
      { implId: 'anthropic_messages', point: 'llm_protocol' },
    ]);
    const tree = withScopeImpls({
      anthropic_compatible: { order: 1 },
      anthropic_messages: { order: 1 },
    }).inventory();
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0]!.groupId).toBe('provider');
    const flat = flattenImpls(tree.groups);
    const ids = flat.map((e) => e.implId).sort();
    expect(ids).toEqual(['anthropic_compatible', 'anthropic_messages']);
  });

  it('groups[0].groupId=provider（按 groupMeta 声明序聚合，首组即 provider）', () => {
    regPlugin('p1', [{ implId: 'a', point: 'llm_provider' }]);
    const tree = withScopeImpls({ a: { order: 1 } }).inventory();
    expect(tree.groups[0]!.groupId).toBe('provider');
  });

  it('ext impl 字段完整（pluginId/pointId/implId/type/pluginEnabled/enabled）', () => {
    regPlugin('p1', [{ implId: 'a', point: 'llm_provider' }]);
    const tree = withScopeImpls({ a: { order: 1 } }).inventory();
    const impl = flattenImpls(tree.groups)[0]!;
    expect(impl.pluginId).toBe('p1');
    expect(impl.implId).toBe('a');
    expect(impl.pointId).toBe('llm_provider');
    // [v0.0.5] 原 cardinality 改名 type（值不变）
    expect(impl.type).toBe('list');
    expect(impl.pluginEnabled).toBe(true); // P0 默认开（plugin 级）
    expect(impl.enabled).toBe(true); // v0.0.179 membership：a 在 impls 字典 = active
  });

  it('树存在性 100% 来自 registry（registry 加 plugin → inventory 自动含）', () => {
    regPlugin('p1', [{ implId: 'a', point: 'llm_provider' }]);
    let tree = withScopeImpls({ a: { order: 1 } }).inventory();
    expect(flattenImpls(tree.groups)).toHaveLength(1);
    // 再加一个 plugin，inventory 自动含（不写任何数据）
    regPlugin('p2', [{ implId: 'b', point: 'llm_provider' }]);
    tree = withScopeImpls({ a: { order: 1 }, b: { order: 2 } }).inventory();
    const ids = flattenImpls(tree.groups).map((e) => e.pluginId).sort();
    expect(ids).toEqual(['p1', 'p2']);
  });
});

describe('PluginConfigService.setEnabled/setImplEnabled — v0.0.67 写路径已删（HTTP 层 task 3 路由同步删）', () => {
  it('v0.0.67 写方法不存在：setEnabled/setImplEnabled/setOrder/setImplConfig/setConfig/persist/setExclusive 已删', () => {
    // 用户指示「直接删写方法，无死代码」——验证 service 上无写方法（防回归）
    expect(typeof (svc as unknown as { setEnabled?: unknown }).setEnabled).toBe('undefined');
    expect(typeof (svc as unknown as { setImplEnabled?: unknown }).setImplEnabled).toBe('undefined');
    expect(typeof (svc as unknown as { setOrder?: unknown }).setOrder).toBe('undefined');
    expect(typeof (svc as unknown as { setImplConfig?: unknown }).setImplConfig).toBe('undefined');
    expect(typeof (svc as unknown as { setConfig?: unknown }).setConfig).toBe('undefined');
    expect(typeof (svc as unknown as { persist?: unknown }).persist).toBe('undefined');
    expect(typeof (svc as unknown as { setExclusive?: unknown }).setExclusive).toBe('undefined');
  });
});
