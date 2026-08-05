/**
 * PluginConfigService v0.0.5 扩展单测（白盒）
 * 参考: specs/tech/version_logs/v0.0.5/change_log.md §修订1/§修订2/§修订4
 *       specs/api/overall/02-llm-chat.md §4.3（GET inventory: plugins[] + type + configSchema）
 *
 * 覆盖 v0.0.5 三项增量（v0.0.71 嵌套结构 + D7 单一 configSchema 后调整）：
 *   1. inventory 顶层 plugins[]（plugin-centric 平面，JOIN manifest.label/description + store.enabled）
 *   2. ext impl 节点 cardinality→type 字段重命名（值不变 exclusive/list/ordered）
 *   3. v0.0.71 D7：删 schemaConfig 透传，改单一 configSchema 字段（详见 inventory-builder.test.ts）
 *   4. setEnabled 独立性回归（改 A 不影响 B —— 后端无 v0.0.4 联动 bug）
 *
 * v0.0.71 D3 嵌套化：groups[].extImpls[] → groups[].points[].impls[]，本测试用 flatten 拍平断言。
 * bug-A JOIN default + D7 configSchema 透传 + flagged ② 详细覆盖见 inventory-builder.test.ts。
 *
 * 文件系统隔离：所有测试用 os.tmpdir() + mkdtempSync + afterEach 清理，禁读真实 DATA_DIR。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Registry } from '../registry';
import { PluginConfigService } from '../plugin-config-service';
import { LlmProviderPoint, LlmProtocolPoint, type ExtensionPoint } from '../extension-point';
import { LoadedScopeConfigProvider } from '../scope-config-provider';
import { LoadedGroupMetaProvider } from '../group-meta-provider';
import { flattenImpls } from './test-helpers';
import type { PluginManifest, ExtImpl } from '../manifest';

let tmpRoot: string;
let registry: Registry;
let svc: PluginConfigService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cfg-v005-'));
  registry = new Registry();
  registry.registerExtensionPoint(LlmProviderPoint);
  registry.registerExtensionPoint(LlmProtocolPoint);
  // v0.0.71：pre-register 自定义 EP（具体 it() 内 regPoint 可覆盖 cardinality），
  // 让默认 groupMeta 安全引用（D6 不变量：groupMeta 引用 pointId 必须在 registry）
  registry.registerExtensionPoint({ id: 'ep_excl', cardinality: 'exclusive' });
  registry.registerExtensionPoint({ id: 'ep_ord', cardinality: 'ordered' });
  svc = new PluginConfigService(registry, {
    root: tmpRoot,
    scopeConfigs: new LoadedScopeConfigProvider([
      { scopeId: 'default', name: 'Default', activatedPoints: [], impls: {} },
    ]),
    // v0.0.71 D1：注入 groupMeta（合成单 group 包含所有 UT EP，inventory-builder 用）
    groupMeta: new LoadedGroupMetaProvider([
      {
        id: 'g1',
        label: '__MSG_group.g1.label__',
        description: '__MSG_group.g1.description__',
        extPoints: ['llm_provider', 'llm_protocol', 'ep_excl', 'ep_ord'],
      },
    ]),
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

class P {}
class Q {}

/** 登记一份 manifest（v0.0.71 D7：删 schemaConfig 字段，改 configSchema） */
function regPluginFull(
  pluginId: string,
  opts: { label?: string; description?: string },
  extImpls: Array<{
    implId: string;
    point: string;
  }>,
): void {
  const full: ExtImpl[] = extImpls.map((e) => ({
    implId: e.implId,
    point: e.point,
    impl: './' + e.implId + '.ts',
  }));
  const m: PluginManifest = {
    id: pluginId,
    extImpls: full,
    label: opts.label,
    description: opts.description,
  };
  const classes = extImpls.map((e) => (e.point === 'llm_provider' ? P : Q));
  registry.register(m, ...classes);
}

/** 登记一个自定义 cardinality 的 EP（exclusive/ordered 测试用） */
function regPoint(point: ExtensionPoint): void {
  registry.registerExtensionPoint(point);
}

// flattenImpls 自 test-helpers 共享（v0.0.71 D3 嵌套化拍平辅助）

// ─────────────────────────────────────────────────────────────
// §1 顶层 plugins[]（plugin-centric 平面）
// ─────────────────────────────────────────────────────────────
describe('v0.0.5 inventory.plugins[] — plugin-centric 平面（插件 tab UI 用）', () => {
  it('inventory 返回顶层 plugins[] 数组（与 groups[] 并存）', () => {
    regPluginFull('p1', { label: 'P1', description: 'd1' }, [
      { implId: 'a', point: 'llm_provider' },
    ]);
    const tree = svc.inventory();
    expect(Array.isArray(tree.plugins)).toBe(true);
    expect(tree.plugins).toHaveLength(1);
    expect(tree.groups).toBeDefined(); // 并存
  });

  it('plugins[] 字段 {pluginId, label, description, enabled} 完整', () => {
    regPluginFull(
      'p1',
      { label: 'Plugin One', description: 'desc one' },
      [{ implId: 'a', point: 'llm_provider' }],
    );
    const tree = svc.inventory();
    const p = tree.plugins[0]!;
    expect(p.pluginId).toBe('p1');
    expect(p.label).toBe('Plugin One');
    expect(p.description).toBe('desc one');
    expect(p.enabled).toBe(true); // P0 默认开
  });

  it('manifest 无 label/description → fallback（label=pluginId, description=空串）', () => {
    regPluginFull('p1', {}, [{ implId: 'a', point: 'llm_provider' }]);
    const tree = svc.inventory();
    const p = tree.plugins[0]!;
    expect(p.label).toBe('p1'); // fallback 到 pluginId
    expect(p.description).toBe(''); // fallback 空串
  });

  it('多 plugin → plugins[] 按 pluginId 字典序稳定排序', () => {
    regPluginFull('zeta', {}, [{ implId: 'a', point: 'llm_provider' }]);
    regPluginFull('alpha', {}, [{ implId: 'b', point: 'llm_provider' }]);
    regPluginFull('mid', {}, [{ implId: 'c', point: 'llm_protocol' }]);
    const tree = svc.inventory();
    const ids = tree.plugins.map((p) => p.pluginId);
    expect(ids).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('v0.0.67 plugins[].enabled 恒 true（plugin 级 native 受信，写方法已删无 policy 写入）', () => {
    regPluginFull('p1', {}, [{ implId: 'a', point: 'llm_provider' }]);
    const tree = svc.inventory();
    expect(tree.plugins[0]!.enabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// §2 ext impl 节点 type 字段（cardinality→type 改名）
// ─────────────────────────────────────────────────────────────
describe('v0.0.5 ext impl.type — cardinality 改名 type（值不变；v0.0.71 嵌套化拍平断言）', () => {
  it('list EP → ext impl.type="list"', () => {
    regPluginFull('p1', {}, [{ implId: 'a', point: 'llm_provider' }]);
    const tree = svc.inventory();
    expect(flattenImpls(tree.groups)[0]!.type).toBe('list');
  });

  it('exclusive EP → ext impl.type="exclusive"', () => {
    regPoint({ id: 'ep_excl', cardinality: 'exclusive' });
    regPluginFull('p1', {}, [{ implId: 'a', point: 'ep_excl' }]);
    const tree = svc.inventory();
    const impl = flattenImpls(tree.groups).find((e) => e.pointId === 'ep_excl')!;
    expect(impl.type).toBe('exclusive');
  });

  it('ordered EP → ext impl.type="ordered"（v0.0.18: 单 impl effective order=1）', () => {
    regPoint({ id: 'ep_ord', cardinality: 'ordered' });
    regPluginFull('p1', {}, [{ implId: 'a', point: 'ep_ord' }]);
    const tree = svc.inventory();
    const impl = flattenImpls(tree.groups).find((e) => e.pointId === 'ep_ord')!;
    expect(impl.type).toBe('ordered');
    // v0.0.18: 删 priority 后单 impl effective order = 1（补位算法）
    expect(impl.order).toBe(1);
  });

  it('ext impl 节点不再含 cardinality 字段（仅 type）', () => {
    regPluginFull('p1', {}, [{ implId: 'a', point: 'llm_provider' }]);
    const tree = svc.inventory();
    const impl = flattenImpls(tree.groups)[0]! as unknown as Record<string, unknown>;
    expect(impl['type']).toBe('list');
    expect(impl['cardinality']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// §3 v0.0.71 D7：删 schemaConfig 透传（详覆盖见 inventory-builder.test.ts）
// ─────────────────────────────────────────────────────────────
describe('v0.0.71 D7 — schemaConfig 字段已删（单一 configSchema 源）', () => {
  it('ExtImplNode 不再含 schemaConfig 字段（全系统只剩 configSchema）', () => {
    regPluginFull('p1', {}, [{ implId: 'a', point: 'llm_provider' }]);
    const tree = svc.inventory();
    const impl = flattenImpls(tree.groups)[0]! as unknown as Record<string, unknown>;
    // D7：schemaConfig 字段已从 ExtImplNode 移除（manifest 类型由 T4 删）
    expect(impl['schemaConfig']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// §4 v0.0.67 起写方法已删（原 setEnabled 独立性回归，配置只读化后写路径不存在）
// ─────────────────────────────────────────────────────────────
describe('v0.0.5 setEnabled 独立性回归 — v0.0.67 写路径已删', () => {
  it('v0.0.67 inventory.plugin 级恒 true（写方法不存在，无 setEnabled 可调）', () => {
    regPluginFull('p1', {}, [{ implId: 'a', point: 'llm_provider' }]);
    regPluginFull('p2', {}, [{ implId: 'b', point: 'llm_provider' }]);
    // 写方法已删——验证不存在（防回归，对应 design.md §3 D4 + 用户「直接删」指示）
    expect(typeof (svc as unknown as { setEnabled?: unknown }).setEnabled).toBe('undefined');
    const tree = svc.inventory();
    const flat = flattenImpls(tree.groups);
    const a = flat.find((e) => e.pluginId === 'p1')!;
    const b = flat.find((e) => e.pluginId === 'p2')!;
    expect(a.pluginEnabled).toBe(true);
    expect(b.pluginEnabled).toBe(true);
  });
});
