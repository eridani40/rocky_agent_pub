/**
 * ScopeConfigValidator 单测（白盒）—— 代码声明配置 vs registry 一致性校验
 * 参考: states/v0.0.179.plugin_config/verify/test-plan.md §UT（Validator 部分）
 *       specs/tech/plugin_system/[P1]scopes_config_decl.md §3.2（校验不变量）
 *
 * v0.0.179 模型简化后校验三类不变量：
 *   1. pointId 存在：activatedPoints 每个 pointId 必须在 registry 已登记
 *   2. implId 存在：impls.keys 必须在 registry；且 impl 实际归属的 point 必须在 activatedPoints
 *   3. exclusive EP active 数恰好 1：activatedPoints 中每个 cardinality=exclusive 的 EP，
 *      其 impls 字典中 active impl 数 = 1（0 或 >1 throw，消息含 scopeId+pointId+实际 count）
 *
 * 真实 manifest 走 BuiltinLoader（端到端），单独场景用最小化 Registry + register() 手工注入。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ScopeConfigValidator } from '../scope-config-validator';
import type { ScopeConfig } from '../scope-config-loader';
import type { GroupMeta } from '../group-meta-loader';
import { Registry } from '../registry';
import { BuiltinLoader } from '../builtin-loader';
import { BUILTIN_EXTENSION_POINTS } from '../extension-point';

/** 占位 impl 类（registry 持有类引用，validator 不实例化） */
class FakeImpl {}

/**
 * 在 registry 中登记一组 EP + impl（最小化 fixture，不走 manifest 文件系统）。
 * 用 Registry 公开 API（registerExtensionPoint / register），保证校验逻辑跑真实代码。
 */
function registerFixtures(
  registry: Registry,
  eps: Array<{ id: string; cardinality: 'exclusive' | 'list' | 'ordered' }>,
  impls: Array<{ implId: string; point: string }>,
): void {
  for (const ep of eps) {
    registry.registerExtensionPoint({
      id: ep.id,
      cardinality: ep.cardinality,
    });
  }
  if (impls.length > 0) {
    registry.register({
      id: 'fake_test_plugin',
      extImpls: impls.map((i) => ({
        implId: i.implId,
        point: i.point,
        impl: './fake.ts',
      })),
    }, ...impls.map(() => FakeImpl));
  }
}

describe('ScopeConfigValidator — 真实 manifest + 真实 scopes.yaml 端到端', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-validator-real-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('加载真实 builtin plugins + 真实 scopes/*.yaml + 真实 groups.json，validateAll全绿', async () => {
    const registry = new Registry();
    for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
    const realBuiltins = path.join(__dirname, '../../../../plugins/builtins');
    await new BuiltinLoader(realBuiltins).loadAll(registry);

    // 真实 scopes/*.yaml（test scope 仅 test env 加载——非 test env test_chat_model EP 未注册会失败）
    const realScopes = path.join(__dirname, '../../../../plugins/scopes');
    const { ScopeConfigLoader } = await import('../scope-config-loader');
    const configs = new ScopeConfigLoader(realScopes)
      .loadAll()
      .filter((c) => c.scopeId !== 'test');
    expect(configs.length).toBeGreaterThanOrEqual(2);

    // 真实 groups.json（16 EP 各归 10 group）
    const realGroups = path.join(__dirname, '../../../../plugins/groups.json');
    const { GroupMetaLoader } = await import('../group-meta-loader');
    const groups = new GroupMetaLoader(realGroups).load().groups;

    const validator = new ScopeConfigValidator({ registry, groups });
    expect(() => validator.validateAll(configs)).not.toThrow();
  });
});

describe('ScopeConfigValidator — pointId 未知 → throw', () => {
  it('activatedPoints 含未登记 pointId → throw（消息含 scopeId + pointId）', () => {
    const r = new Registry();
    registerFixtures(r, [{ id: 'ep1', cardinality: 'exclusive' }], []);
    const cfg: ScopeConfig = {
      scopeId: 's1',
      name: 'S1',
      activatedPoints: ['ep1', 'unknown_ep'],
      impls: {},
    };
    const v = new ScopeConfigValidator({ registry: r, groups: [] });
    expect(() => v.validateOne(cfg)).toThrow(
      /scope "s1" activatedPoints 含未知 pointId "unknown_ep"/,
    );
  });
});

describe('ScopeConfigValidator — implId 未知 → throw', () => {
  it('impls 含未注册 implId → throw（消息含 implId）', () => {
    const r = new Registry();
    registerFixtures(r, [{ id: 'ep1', cardinality: 'list' }], []);
    const cfg: ScopeConfig = {
      scopeId: 's1',
      name: 'S1',
      activatedPoints: ['ep1'],
      impls: { unknown_impl: { order: 1 } },
    };
    const v = new ScopeConfigValidator({ registry: r, groups: [] });
    expect(() => v.validateOne(cfg)).toThrow(
      /impls 含未知 implId "unknown_impl"/,
    );
  });

  it('impls 中 impl 实际归属的 point 未激活 → throw（防跨 point 误列）', () => {
    const r = new Registry();
    registerFixtures(
      r,
      [
        { id: 'ep1', cardinality: 'list' },
        { id: 'ep2', cardinality: 'list' },
      ],
      [{ implId: 'impl_for_ep2', point: 'ep2' }],
    );
    // scope 激活 ep1 但 impl 实际归属 ep2 → 跨 point 误列
    const cfg: ScopeConfig = {
      scopeId: 's1',
      name: 'S1',
      activatedPoints: ['ep1'], // 不含 ep2
      impls: { impl_for_ep2: { order: 1 } },
    };
    const v = new ScopeConfigValidator({ registry: r, groups: [] });
    expect(() => v.validateOne(cfg)).toThrow(
      /归属 point "ep2" 未在该 scope activatedPoints/,
    );
  });
});

describe('ScopeConfigValidator — exclusive EP active 数恰好 1（v0.0.179 新校验）', () => {
  it('1 active → pass（exclusive EP 恰好 1 active）', () => {
    const r = new Registry();
    registerFixtures(r, [{ id: 'ep1', cardinality: 'exclusive' }], [
      { implId: 'impl1', point: 'ep1' },
      { implId: 'impl2', point: 'ep1' },
    ]);
    const cfg: ScopeConfig = {
      scopeId: 's1',
      name: 'S1',
      activatedPoints: ['ep1'],
      impls: { impl1: { order: 1 } }, // 恰好 1 active
    };
    const v = new ScopeConfigValidator({ registry: r, groups: [] });
    expect(() => v.validateOne(cfg)).not.toThrow();
  });

  it('0 active → throw（消息含 scopeId + pointId + 实际 count=0）', () => {
    const r = new Registry();
    registerFixtures(r, [{ id: 'ep1', cardinality: 'exclusive' }], [
      { implId: 'impl1', point: 'ep1' },
    ]);
    const cfg: ScopeConfig = {
      scopeId: 's1',
      name: 'S1',
      activatedPoints: ['ep1'],
      impls: {}, // 0 active
    };
    const v = new ScopeConfigValidator({ registry: r, groups: [] });
    expect(() => v.validateOne(cfg)).toThrow(
      /scope "s1" 激活了 exclusive EP "ep1"，需恰好 1 个 active impl，实际 0 个/,
    );
  });

  it('>1 active → throw（消息含 scopeId + pointId + 实际 count=2）', () => {
    const r = new Registry();
    registerFixtures(r, [{ id: 'ep1', cardinality: 'exclusive' }], [
      { implId: 'impl1', point: 'ep1' },
      { implId: 'impl2', point: 'ep1' },
    ]);
    const cfg: ScopeConfig = {
      scopeId: 's1',
      name: 'S1',
      activatedPoints: ['ep1'],
      impls: { impl1: { order: 1 }, impl2: { order: 2 } }, // 2 active（互斥违规）
    };
    const v = new ScopeConfigValidator({ registry: r, groups: [] });
    expect(() => v.validateOne(cfg)).toThrow(
      /scope "s1" 激活了 exclusive EP "ep1"，需恰好 1 个 active impl，实际 2 个/,
    );
  });

  it('exclusive EP 未激活（不在 activatedPoints）→ 跳过（不强制 1 active）', () => {
    const r = new Registry();
    registerFixtures(r, [{ id: 'ep1', cardinality: 'exclusive' }], [
      { implId: 'impl1', point: 'ep1' },
    ]);
    const cfg: ScopeConfig = {
      scopeId: 's1',
      name: 'S1',
      activatedPoints: [], // ep1 未激活
      impls: {},
    };
    const v = new ScopeConfigValidator({ registry: r, groups: [] });
    expect(() => v.validateOne(cfg)).not.toThrow();
  });
});

describe('ScopeConfigValidator — validateAll 批量', () => {
  it('validateAll 首个错即 throw（不静默跳过）', () => {
    const r = new Registry();
    registerFixtures(r, [{ id: 'ep1', cardinality: 'exclusive' }], [
      { implId: 'impl1', point: 'ep1' },
    ]);
    const good: ScopeConfig = {
      scopeId: 'good',
      name: 'G',
      activatedPoints: ['ep1'],
      impls: { impl1: { order: 1 } }, // 恰好 1 active
    };
    const bad: ScopeConfig = {
      scopeId: 'bad',
      name: 'B',
      activatedPoints: ['ep1'],
      impls: {}, // 0 active → throw
    };
    // groups 必须覆盖 registry 的所有 EP，否则 validateGroups 先于 scope 校验失败
    const groups: GroupMeta[] = [
      { id: 'g1', label: 'G1', description: 'G1', extPoints: ['ep1'] },
    ];
    const v = new ScopeConfigValidator({ registry: r, groups });
    expect(() => v.validateAll([good, bad])).toThrow(/scope "bad"/);
  });
});

describe('ScopeConfigValidator — default 形状 scope 通过（最小化 registry fixture）', () => {
  it('全 EP 激活 + 3 exclusive 恰好 1 active → 通过', () => {
    // 用真实 BUILTIN_EXTENSION_POINTS 注入 EP，再手登记 active impl
    const r = new Registry();
    for (const ep of BUILTIN_EXTENSION_POINTS) r.registerExtensionPoint(ep);
    registerFixtures(r, [], [
      { implId: 'threshold_should_compact', point: 'context_should_compact' },
      { implId: 'summary_do_compact', point: 'context_do_compact' },
      { implId: 'persistent_session_store', point: 'session_store' },
      { implId: 'zhipu', point: 'web_search_provider' },
      { implId: 'base_builder', point: 'context_assemble_reducer' },
    ]);
    const cfg: ScopeConfig = {
      scopeId: 'default_min',
      name: 'Default Min',
      activatedPoints: [
        'llm_provider', 'llm_protocol',
        'context_should_compact', 'context_do_compact',
        'session_store', 'web_search_provider',
        'context_assemble_reducer',
      ],
      impls: {
        threshold_should_compact: { order: 1 },
        summary_do_compact: { order: 1 },
        persistent_session_store: { order: 1 },
        zhipu: { order: 1 },
        base_builder: { order: 1 },
      },
    };
    // validateOne 不跑 validateGroups，groups 传 [] 即可
    const v = new ScopeConfigValidator({ registry: r, groups: [] });
    expect(() => v.validateOne(cfg)).not.toThrow();
  });
});

// ============================================================
// v0.0.71 D6 第 5 条：validateGroups（registry ↔ groups.json 双向一致）—— 4 fail + 1 happy
// ============================================================
describe('ScopeConfigValidator — validateGroups（D6 第 5 条不变量）', () => {
  it('happy: registry EP 全在 groups 中 + groups 引用的 EP 全在 registry → 不 throw', () => {
    const r = new Registry();
    registerFixtures(
      r,
      [
        { id: 'ep_a', cardinality: 'list' },
        { id: 'ep_b', cardinality: 'ordered' },
        { id: 'ep_c', cardinality: 'exclusive' },
      ],
      [],
    );
    const groups: GroupMeta[] = [
      {
        id: 'g1',
        label: 'G1',
        description: 'G1',
        extPoints: ['ep_a', 'ep_b'],
      },
      { id: 'g2', label: 'G2', description: 'G2', extPoints: ['ep_c'] },
    ];
    const v = new ScopeConfigValidator({ registry: r, groups });
    expect(() => v.validateGroups()).not.toThrow();
  });

  it('fail-1: registry EP 未在任何 group 登记 → throw（消息含 pointId）', () => {
    const r = new Registry();
    registerFixtures(
      r,
      [
        { id: 'ep_a', cardinality: 'list' },
        { id: 'ep_unmanaged', cardinality: 'list' },
      ],
      [],
    );
    // groups 漏登记 ep_unmanaged
    const groups: GroupMeta[] = [
      { id: 'g1', label: 'G1', description: 'G1', extPoints: ['ep_a'] },
    ];
    const v = new ScopeConfigValidator({ registry: r, groups });
    expect(() => v.validateGroups()).toThrow(
      /registry EP "ep_unmanaged" 未在任何 group 登记/,
    );
  });

  it('fail-2: groups 引用的 pointId 未在 registry 登记 → throw（防漂移，消息含 pointId + group）', () => {
    const r = new Registry();
    registerFixtures(r, [{ id: 'ep_a', cardinality: 'list' }], []);
    // groups 引用不存在的 EP
    const groups: GroupMeta[] = [
      {
        id: 'g1',
        label: 'G1',
        description: 'G1',
        extPoints: ['ep_a', 'ep_phantom'],
      },
    ];
    const v = new ScopeConfigValidator({ registry: r, groups });
    expect(() => v.validateGroups()).toThrow(
      /group "g1" 引用的 pointId "ep_phantom" 未在 registry 登记/,
    );
  });

  it('fail-3: group id 重复 → constructor throw', () => {
    const r = new Registry();
    registerFixtures(r, [{ id: 'ep_a', cardinality: 'list' }], []);
    const groups: GroupMeta[] = [
      { id: 'dup', label: 'A', description: 'A', extPoints: ['ep_a'] },
      // 同 id 重复（即使 extPoints 不同也违规）
      { id: 'dup', label: 'B', description: 'B', extPoints: [] },
    ];
    expect(
      () => new ScopeConfigValidator({ registry: r, groups }),
    ).toThrow(/重复 group id "dup"/);
  });

  it('fail-4: 同 pointId 在多个 group 重复登记 → constructor throw', () => {
    const r = new Registry();
    registerFixtures(r, [{ id: 'ep_a', cardinality: 'list' }], []);
    const groups: GroupMeta[] = [
      { id: 'g1', label: 'G1', description: 'G1', extPoints: ['ep_a'] },
      // ep_a 又出现在 g2（一个 EP 应只归属一个 group）
      { id: 'g2', label: 'G2', description: 'G2', extPoints: ['ep_a'] },
    ];
    expect(
      () => new ScopeConfigValidator({ registry: r, groups }),
    ).toThrow(/pointId "ep_a" 在 group "g1" 和 "g2" 重复登记/);
  });
});
