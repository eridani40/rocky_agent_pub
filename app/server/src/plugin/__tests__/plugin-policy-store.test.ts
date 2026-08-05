/**
 * PluginPolicyStore 单测（白盒）—— persist 落盘 + 稀疏 delta 读/写 + [v0.0.26] 复合 key + migrate
 * 参考: specs/tech/config/[P0]plugin_config_service.md §3（overlay 稀疏 delta）
 *       specs/tech/config/[P0]plugin_config.md（数据形状）
 *       specs/tech/config/[P0]ext_impl_scope.md §4（F2 复合 key + D2 编码 + D3 lazy migrate）
 *       states/v0.0.26/verify/test-plan.md §0
 *
 * 设计：
 *   - 单 entity plugin_policy，按 kind（'plugin'|'impl'）分片
 *   - plugin 级 record: key=pluginId（不分 scope），data={enabled?, configValues?}
 *   - ext impl 级 record: [v0.0.26] key=${scopeId}::${implId}（复合 key），data={enabled?, order?, configValues?, exclusive?}
 *   - 稀疏 delta：未写入 → get 返 undefined
 *   - migrate 幂等：旧单 implId key → default::implId
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { PluginPolicyStore } from '../plugin-policy-store';

let tmpRoot: string;
let store: PluginPolicyStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-policy-'));
  store = new PluginPolicyStore({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 递归扫 dir 下所有 .json record，返回 [filePath, parsed] 对（FsCrudStore 嵌套层级无硬编码）。
 * migrate / 落盘校验 / ULID 不变 多处复用，避免重复 walk。
 */
function collectRecords(dir: string = tmpRoot): { fp: string; rec: Record<string, unknown> }[] {
  const out: { fp: string; rec: Record<string, unknown> }[] = [];
  function walk(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.isFile() && e.name.endsWith('.json'))
        out.push({ fp, rec: JSON.parse(fs.readFileSync(fp, 'utf8')) });
    }
  }
  walk(dir);
  return out;
}

describe('PluginPolicyStore plugin 级稀疏 delta（不分 scope，PRD OUT）', () => {
  it('未写入 → getPlugin 返 undefined（视为未配置，按默认 enabled=true）', () => {
    expect(store.getPlugin('p1')).toBeUndefined();
  });

  it('setPlugin 后 getPlugin 命中', () => {
    store.setPlugin('p1', { enabled: false, configValues: { x: 1 } });
    expect(store.getPlugin('p1')).toEqual({ enabled: false, configValues: { x: 1 } });
  });

  it('同 pluginId 再 set 覆盖（upsert）', () => {
    store.setPlugin('p1', { enabled: false });
    store.setPlugin('p1', { enabled: true, configValues: { y: 2 } });
    expect(store.getPlugin('p1')).toEqual({ enabled: true, configValues: { y: 2 } });
  });

  it('delete 恢复默认（删 record，spec §3 「恢复默认 = 删 record」）', () => {
    store.setPlugin('p1', { enabled: false });
    expect(store.getPlugin('p1')).toBeDefined();
    store.deletePlugin('p1');
    expect(store.getPlugin('p1')).toBeUndefined();
  });
});

describe('PluginPolicyStore impl 级 API [v0.0.26] 单参重载 ≡ default 向后兼容', () => {
  it('未写入 → getImpl 单参返 undefined', () => {
    expect(store.getImpl('anthropic_messages')).toBeUndefined();
  });

  it('setImpl 单参写 + getImpl 单参读 命中（含 order）', () => {
    store.setImpl('anthropic_messages', {
      enabled: false,
      order: 5,
      configValues: { apiKey: 'sk-x' },
    });
    expect(store.getImpl('anthropic_messages')).toEqual({
      enabled: false,
      order: 5,
      configValues: { apiKey: 'sk-x' },
    });
  });

  it('setImpl 不带 order（list/exclusive 点）', () => {
    store.setImpl('a', { enabled: false });
    expect(store.getImpl('a')).toEqual({ enabled: false });
  });

  it('单参 setImpl 等价双参 setImpl("default", implId, data)', () => {
    store.setImpl('a', { enabled: false, order: 1 }); // 单参
    store.setImpl('default', 'b', { enabled: true }); // 双参 default
    // 单参读 ≡ default 读
    expect(store.getImpl('a')).toEqual({ enabled: false, order: 1 });
    expect(store.getImpl('default', 'a')).toEqual({ enabled: false, order: 1 });
    expect(store.getImpl('b')).toEqual({ enabled: true });
    expect(store.getImpl('default', 'b')).toEqual({ enabled: true });
  });

  it('deleteImpl 单参删 default 的 impl（向后兼容）', () => {
    store.setImpl('a', { enabled: false });
    store.deleteImpl('a');
    expect(store.getImpl('a')).toBeUndefined();
  });
});

describe('PluginPolicyStore impl 级 API [v0.0.26] 双参重载 per-scope 复合 key', () => {
  it('双参写不同 scope 下同 implId 互不冲突（per-scope 独立配置）', () => {
    store.setImpl('default', 'impl_x', { enabled: true, order: 1 });
    store.setImpl('custom', 'impl_x', { enabled: false, order: 2 });
    expect(store.getImpl('default', 'impl_x')).toEqual({ enabled: true, order: 1 });
    expect(store.getImpl('custom', 'impl_x')).toEqual({ enabled: false, order: 2 });
  });

  it('双参写某 scope 不影响 default（scope 独立）', () => {
    store.setImpl('default', 'impl_x', { enabled: true });
    store.setImpl('custom', 'impl_x', { enabled: false });
    // custom 改动不传导 default
    expect(store.getImpl('default', 'impl_x')).toEqual({ enabled: true });
  });

  it('未写入某 scope 的 impl → getImpl 返 undefined（视为未配置）', () => {
    store.setImpl('default', 'impl_x', { enabled: true });
    expect(store.getImpl('custom', 'impl_x')).toBeUndefined();
  });

  it('双参 setImpl upsert：同 (scopeId, implId) 再写覆盖', () => {
    store.setImpl('custom', 'impl_x', { enabled: false });
    store.setImpl('custom', 'impl_x', { enabled: true, order: 3 });
    expect(store.getImpl('custom', 'impl_x')).toEqual({ enabled: true, order: 3 });
  });

  it('双参 deleteImpl 只删该 scope 该 impl（不影响其他 scope）', () => {
    store.setImpl('default', 'impl_x', { enabled: true });
    store.setImpl('custom', 'impl_x', { enabled: false });
    store.deleteImpl('custom', 'impl_x');
    expect(store.getImpl('custom', 'impl_x')).toBeUndefined();
    expect(store.getImpl('default', 'impl_x')).toEqual({ enabled: true });
  });
});

describe('PluginPolicyStore listImpls [v0.0.26] scope 前缀过滤', () => {
  it('无参 listImpls 全量（兼容旧调用）', () => {
    store.setImpl('default', 'a', { enabled: true });
    store.setImpl('custom', 'b', { enabled: false });
    const all = store.listImpls();
    expect(all.map((r) => r.key).sort()).toEqual(['custom::b', 'default::a']);
  });

  it('带 scopeId：只返该 scope 下 impl policy（前缀过滤，不多不漏）', () => {
    store.setImpl('default', 'a', { enabled: true });
    store.setImpl('default', 'b', { enabled: false });
    store.setImpl('custom', 'c', { enabled: true });
    store.setImpl('release', 'd', { order: 5 });

    const defaultImpls = store.listImpls('default');
    expect(defaultImpls.map((r) => r.implId).sort()).toEqual(['a', 'b']);
    expect(defaultImpls.every((r) => r.scopeId === 'default')).toBe(true);

    const customImpls = store.listImpls('custom');
    expect(customImpls.map((r) => r.implId)).toEqual(['c']);
    expect(customImpls[0]?.scopeId).toBe('custom');

    const releaseImpls = store.listImpls('release');
    expect(releaseImpls.map((r) => r.implId)).toEqual(['d']);
    expect(releaseImpls[0]?.data.order).toBe(5);
  });

  it('带 scopeId：scopeId 前缀冲突不误匹配（如 scope=default 不应匹配 default-x）', () => {
    store.setImpl('default', 'a', { enabled: true });
    store.setImpl('default-x', 'b', { enabled: false }); // 不同 scope
    const def = store.listImpls('default');
    // default 不应误匹配 default-x::b（前缀分隔符 `::` 防越界）
    expect(def.map((r) => r.implId)).toEqual(['a']);
    const defX = store.listImpls('default-x');
    expect(defX.map((r) => r.implId)).toEqual(['b']);
  });

  it('带 scopeId：空 scope 返空数组（不抛错）', () => {
    store.setImpl('default', 'a', { enabled: true });
    expect(store.listImpls('nonexistent')).toEqual([]);
  });
});

describe('PluginPolicyStore listImplsByPoint [v0.0.26] 按 implIds 集合过滤', () => {
  it('只返该 scope 下 pointImplIds 集合内的 impl policy', () => {
    store.setImpl('default', 'a', { enabled: true });
    store.setImpl('default', 'b', { order: 1 });
    store.setImpl('default', 'c', { enabled: false });
    // point P1 包含 impl a, b（不含 c）
    const point1 = store.listImplsByPoint('default', 'point_p1', ['a', 'b']);
    expect(point1.map((r) => r.implId).sort()).toEqual(['a', 'b']);
    expect(point1.every((r) => r.scopeId === 'default')).toBe(true);
  });

  it('pointImplIds 是超集：未写入的 implId 不返（稀疏）', () => {
    store.setImpl('default', 'a', { enabled: true });
    // b 未写入；listImplsByPoint 应只返 a（稀疏 delta，未写不入 list）
    const result = store.listImplsByPoint('default', 'p1', ['a', 'b', 'c']);
    expect(result.map((r) => r.implId)).toEqual(['a']);
  });

  it('pointImplIds 是空集 → 返空数组', () => {
    store.setImpl('default', 'a', { enabled: true });
    expect(store.listImplsByPoint('default', 'p1', [])).toEqual([]);
  });

  it('不同 scope 下同 pointId 互不影响（per-scope 独立）', () => {
    store.setImpl('default', 'a', { enabled: true });
    store.setImpl('custom', 'a', { enabled: false });
    const defP1 = store.listImplsByPoint('default', 'p1', ['a']);
    const customP1 = store.listImplsByPoint('custom', 'p1', ['a']);
    expect(defP1[0]?.data.enabled).toBe(true);
    expect(customP1[0]?.data.enabled).toBe(false);
  });
});


describe('PluginPolicyStore 落盘 kind 分片（plugin / impl 两个 shard 目录）', () => {
  it('plugin 级与 impl 级落不同 shard 目录', () => {
    store.setPlugin('p1', { enabled: false });
    store.setImpl('a', { enabled: true });

    const dirs = new Set<string>();
    function walk(dir: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.name.endsWith('.json')) dirs.add(path.relative(tmpRoot, dir));
      }
    }
    walk(tmpRoot);
    const all = [...dirs].join('|');
    expect(all).toContain('plugin_policy');
    expect(all).toContain('plugin');
    expect(all).toContain('impl');
  });

  it('list 全量 plugin record（供 persist 聚合用）', () => {
    store.setPlugin('p1', { enabled: false });
    store.setPlugin('p2', { enabled: true });
    const plugins = store.listPlugins();
    expect(plugins.map((r) => r.key).sort()).toEqual(['p1', 'p2']);
  });
});
