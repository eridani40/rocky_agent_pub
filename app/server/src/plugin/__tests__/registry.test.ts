/**
 * Registry 单测（白盒）—— manifest schema 形状校验 + (point, implId) 索引登记
 * 参考: specs/tech/plugin_system/[P0]plugin_manager_interface.md §3.4（静态注册）
 *       specs/tech/plugin_system/[P0]ext_impl_and_manifest_interface.md §2（manifest schema）
 *       states/v0.0.3/verify/test-plan.md §1（UT registry 登记）
 */
import { describe, it, expect } from 'vitest';
import { Registry } from '../registry';
import { LlmProviderPoint, LlmProtocolPoint } from '../extension-point';
import type { PluginManifest, ExtImpl } from '../manifest';

// 测试用实现类（registry 持有类引用，不实例化）
class FakeProviderA {
  implId = 'openai_compatible';
}
class FakeProviderB {
  implId = 'anthropic_compatible';
}
class FakeProtocolA {
  implId = 'openai_chat_completions';
}

function makeManifest(
  id: string,
  extImpls: ExtImpl[],
): PluginManifest {
  return { id, extImpls };
}

describe('Registry.register — manifest schema 形状校验', () => {
  it('合法 manifest（id + extImpls[]）登记成功', () => {
    const reg = new Registry();
    const m = makeManifest('p1', [
      { implId: 'openai_compatible', point: 'llm_provider', impl: './a.ts' },
    ]);
    expect(() => reg.register(m, FakeProviderA)).not.toThrow();
  });

  it('manifest 缺 id → 抛错', () => {
    const reg = new Registry();
    const bad = { extImpls: [] } as unknown as PluginManifest;
    expect(() => reg.register(bad, FakeProviderA)).toThrow(/id/);
  });

  it('manifest 缺 extImpls → 抛错', () => {
    const reg = new Registry();
    const bad = { id: 'p1' } as unknown as PluginManifest;
    expect(() => reg.register(bad, FakeProviderA)).toThrow(/extImpls/);
  });

  it('extImpls 非数组 → 抛错', () => {
    const reg = new Registry();
    const bad = { id: 'p1', extImpls: 'nope' } as unknown as PluginManifest;
    expect(() => reg.register(bad, FakeProviderA)).toThrow(/extImpls/);
  });

  it('extImpls[].implId 缺失 → 抛错', () => {
    const reg = new Registry();
    const m = makeManifest('p1', [
      { point: 'llm_provider', impl: './a.ts' } as ExtImpl,
    ]);
    expect(() => reg.register(m, FakeProviderA)).toThrow(/implId/);
  });

  it('extImpls[].point 缺失 → 抛错', () => {
    const reg = new Registry();
    const m = makeManifest('p1', [
      { implId: 'openai_compatible', impl: './a.ts' } as ExtImpl,
    ]);
    expect(() => reg.register(m, FakeProviderA)).toThrow(/point/);
  });
});

describe('Registry.getByPoint — (point, implId) 索引取登记类', () => {
  it('getByPoint 返回该 point 下所有登记 ext impl', () => {
    const reg = new Registry();
    reg.register(
      makeManifest('p1', [
        { implId: 'openai_compatible', point: 'llm_provider', impl: './a.ts' },
      ]),
      FakeProviderA,
    );
    reg.register(
      makeManifest('p2', [
        { implId: 'anthropic_compatible', point: 'llm_provider', impl: './b.ts' },
      ]),
      FakeProviderB,
    );
    const result = reg.getByPoint(LlmProviderPoint.id);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.manifest.implId).sort();
    expect(ids).toEqual(['anthropic_compatible', 'openai_compatible']);
  });

  it('不同 point 互不串（llm_provider 与 llm_protocol 隔离）', () => {
    const reg = new Registry();
    reg.register(
      makeManifest('p1', [
        { implId: 'openai_compatible', point: 'llm_provider', impl: './a.ts' },
        { implId: 'openai_chat_completions', point: 'llm_protocol', impl: './p.ts' },
      ]),
      FakeProviderA,
      FakeProtocolA,
    );
    const providers = reg.getByPoint(LlmProviderPoint.id);
    const protocols = reg.getByPoint(LlmProtocolPoint.id);
    expect(providers).toHaveLength(1);
    expect(protocols).toHaveLength(1);
    expect(providers[0]!.manifest.implId).toBe('openai_compatible');
    expect(protocols[0]!.manifest.implId).toBe('openai_chat_completions');
  });

  it('同 point 同 implId 后者覆盖（last-write）', () => {
    const reg = new Registry();
    reg.register(
      makeManifest('p1', [
        { implId: 'dup', point: 'llm_provider', impl: './a.ts' },
      ]),
      FakeProviderA,
    );
    reg.register(
      makeManifest('p2', [
        { implId: 'dup', point: 'llm_provider', impl: './b.ts' },
      ]),
      FakeProviderB,
    );
    const result = reg.getByPoint(LlmProviderPoint.id);
    expect(result).toHaveLength(1);
    // 后登记者覆盖 → 类引用是 FakeProviderB
    expect(result[0]!.implClass).toBe(FakeProviderB);
    expect(result[0]!.pluginId).toBe('p2');
  });

  it('getByPoint 未登记的 point 返空数组', () => {
    const reg = new Registry();
    expect(reg.getByPoint('unknown_point')).toEqual([]);
  });
});

describe('Registry.getImplById — 单条 impl 查询（供 inventory JOIN 用）', () => {
  it('按 implId 取登记条目', () => {
    const reg = new Registry();
    reg.register(
      makeManifest('p1', [
        { implId: 'openai_compatible', point: 'llm_provider', impl: './a.ts' },
      ]),
      FakeProviderA,
    );
    const r = reg.getImplById('openai_compatible');
    expect(r).toBeDefined();
    expect(r!.pluginId).toBe('p1');
    expect(r!.implClass).toBe(FakeProviderA);
  });

  it('未登记的 implId 返 undefined', () => {
    const reg = new Registry();
    expect(reg.getImplById('nope')).toBeUndefined();
  });
});

describe('Registry.listPlugins / listPoints — 全量树枚举（供 inventory）', () => {
  it('listPlugins 返所有已登记 pluginId 去重列表', () => {
    const reg = new Registry();
    reg.register(
      makeManifest('p1', [
        { implId: 'a', point: 'llm_provider', impl: './a.ts' },
        { implId: 'b', point: 'llm_protocol', impl: './b.ts' },
      ]),
      FakeProviderA,
      FakeProtocolA,
    );
    reg.register(
      makeManifest('p2', [
        { implId: 'c', point: 'llm_provider', impl: './c.ts' },
      ]),
      FakeProviderB,
    );
    expect(reg.listPlugins().sort()).toEqual(['p1', 'p2']);
  });

  it('listPoints 返所有被贡献到的 point id 集合', () => {
    const reg = new Registry();
    reg.register(
      makeManifest('p1', [
        { implId: 'a', point: 'llm_provider', impl: './a.ts' },
        { implId: 'b', point: 'llm_protocol', impl: './b.ts' },
      ]),
      FakeProviderA,
      FakeProtocolA,
    );
    const pts = reg.listPoints().sort();
    expect(pts).toEqual(['llm_protocol', 'llm_provider']);
  });
});

// v0.0.71（D1）：删除 EP.group 字段 + registry 校验，原 describe 块随之删除。
// EP.group 必填校验历史见 specs/tech/version_logs/v0.0.71/change_plan.md 模块 2。
