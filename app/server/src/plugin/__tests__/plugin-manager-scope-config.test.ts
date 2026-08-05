/**
 * PluginManager + ScopeConfig 代码声明 UT — v0.0.179 membership 模型（核心验证点）
 * 参考: specs/tech/config/[P0]ext_impl_scope.md §5（per-EP 回退 + D6 default 短路）
 *
 * v0.0.179 模型简化（impl 列表模型）：
 *   - membership active：key 在 ScopeConfig.impls 字典 = active；不在 = inactive
 *   - 不再有 enabled / exclusivePicks / delta merge
 *   - exclusive EP 恰好 1 active（validator 保证）
 *
 * 覆盖：
 *   - default scope 全 EP active + exclusive 选中项 = impls 字典中该 EP 的唯一 active
 *   - forked scope 关 compact 防 impl（reject/noop exclusive）+ base_builder/store_sink/transcript_reader active
 *   - 未激活 EP 自动回退 default（per-EP 粒度）
 *   - exclusive EP 在 forked 选不同 impl（per-scope 独立）
 *   - ordered EP order 来自代码声明（per-scope）
 */
import { describe, it, expect } from 'vitest';
import { Registry } from '../registry';
import { PluginManager } from '../plugin-manager';
import {
  BUILTIN_EXTENSION_POINTS,
  ContextAssembleReducerPoint,
  ContextIngestHandlerPoint,
  ContextAssembleMapperPoint,
  ContextShouldCompactPoint,
  ContextDoCompactPoint,
  SessionStorePoint,
} from '../extension-point';
import { LoadedScopeConfigProvider } from '../scope-config-provider';
import type { ScopeConfig } from '../scope-config-loader';

/**
 * 模拟 rocky_context builtin 关键 EP + impl 登记（覆盖 default + forked 配置涉及的所有 EP）。
 * 真实 plugin 由 BuiltinLoader 加载，这里只登记测试需要的子集，避免依赖文件系统。
 */
function setupRegistryFixtures(): Registry {
  const registry = new Registry();
  for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);

  class NoopImpl {
    implId: string;
    constructor(implId: string) {
      this.implId = implId;
    }
  }

  // context_assemble_reducer 链（ordered EP，5 impl：base_builder + 4 清理 reducer）
  registry.register(
    {
      id: 'rocky_context_reducer',
      extImpls: [
        { implId: 'base_builder', point: 'context_assemble_reducer', impl: './b.ts' },
        { implId: 'snip_handler', point: 'context_assemble_reducer', impl: './s.ts' },
        { implId: 'orphan_tool_call', point: 'context_assemble_reducer', impl: './o.ts' },
        { implId: 'empty_message', point: 'context_assemble_reducer', impl: './e.ts' },
        { implId: 'role_merge', point: 'context_assemble_reducer', impl: './r.ts' },
      ],
    },
    NoopImpl, NoopImpl, NoopImpl, NoopImpl, NoopImpl,
  );

  // context_ingest_handler EP（list）：store_sink + system_reminder_injector
  registry.register(
    {
      id: 'rocky_context_ingest',
      extImpls: [
        { implId: 'store_sink', point: 'context_ingest_handler', impl: './ss.ts' },
        { implId: 'system_reminder_injector', point: 'context_ingest_handler', impl: './sr.ts' },
      ],
    },
    NoopImpl, NoopImpl,
  );

  // context_assemble_mapper EP（list）：transcript_reader + summary_reader
  registry.register(
    {
      id: 'rocky_context_mapper',
      extImpls: [
        { implId: 'transcript_reader', point: 'context_assemble_mapper', impl: './tr.ts' },
        { implId: 'summary_reader', point: 'context_assemble_mapper', impl: './sr.ts' },
      ],
    },
    NoopImpl, NoopImpl,
  );

  // context_should_compact EP（exclusive）：threshold + reject
  registry.register(
    {
      id: 'rocky_should_compact',
      extImpls: [
        { implId: 'threshold_should_compact', point: 'context_should_compact', impl: './t.ts' },
        { implId: 'reject_should_compact', point: 'context_should_compact', impl: './r.ts' },
      ],
    },
    NoopImpl, NoopImpl,
  );

  // context_do_compact EP（exclusive）：summary + noop
  registry.register(
    {
      id: 'rocky_do_compact',
      extImpls: [
        { implId: 'summary_do_compact', point: 'context_do_compact', impl: './s.ts' },
        { implId: 'noop_do_compact', point: 'context_do_compact', impl: './n.ts' },
      ],
    },
    NoopImpl, NoopImpl,
  );

  // session_store EP（exclusive）：persistent + in_memory
  registry.register(
    {
      id: 'rocky_session_store',
      extImpls: [
        { implId: 'persistent_session_store', point: 'session_store', impl: './p.ts' },
        { implId: 'in_memory_session_store', point: 'session_store', impl: './i.ts' },
      ],
    },
    NoopImpl, NoopImpl,
  );

  return registry;
}

/**
 * v0.0.179 default 配置镜像（全 EP 激活 + membership 列出所有 active impl）。
 * exclusive EP 各恰好 1 active；其他 EP 全 active。
 */
const DEFAULT_CONFIG: ScopeConfig = {
  scopeId: 'default',
  name: 'Default',
  description: '',
  activatedPoints: [
    'context_ingest_handler',
    'context_assemble_mapper',
    'context_assemble_reducer',
    'context_should_compact',
    'context_do_compact',
    'session_store',
  ],
  impls: {
    // assemble_reducer 5 impl（v0.0.179 镜像：实际生产已迁 clean_view EP，这里 UT 自治保留 5 impl）
    base_builder: { order: 1 },
    snip_handler: { order: 2 },
    orphan_tool_call: { order: 3 },
    empty_message: { order: 4 },
    role_merge: { order: 5 },
    // ingest_handler 全 active
    store_sink: { order: 1 },
    system_reminder_injector: { order: 2 },
    // assemble_mapper 全 active
    transcript_reader: { order: 1 },
    summary_reader: { order: 2 },
    // exclusive EP 恰好 1 active
    threshold_should_compact: { order: 1 },
    summary_do_compact: { order: 1 },
    persistent_session_store: { order: 1 },
  },
};

/**
 * v0.0.179 forked 配置镜像（关 compact + session_store 选 in_memory + 清理 reducer active）。
 * 与 default 不同的 EP 才列；未列 EP 继承 default。
 */
const FORKED_CONFIG: ScopeConfig = {
  scopeId: 'forked',
  name: 'forked',
  description: '',
  activatedPoints: [
    'context_ingest_handler',
    'context_assemble_mapper',
    'context_assemble_reducer',
    'context_should_compact',
    'context_do_compact',
    'session_store',
  ],
  impls: {
    // v0.0.179 forked：assemble_reducer 与 default 同（5 impl 全 active）
    base_builder: { order: 1 },
    snip_handler: { order: 2 },
    orphan_tool_call: { order: 3 },
    empty_message: { order: 4 },
    role_merge: { order: 5 },
    // ingest_handler forked 关 system_reminder_injector（只 store_sink）
    store_sink: { order: 1 },
    // assemble_mapper forked 与 default 同（2 impl 全 active）
    transcript_reader: { order: 1 },
    summary_reader: { order: 2 },
    // exclusive EP forked 选不同 impl
    reject_should_compact: { order: 1 },
    noop_do_compact: { order: 1 },
    in_memory_session_store: { order: 1 },
  },
};

function makeManager(configs: ScopeConfig[]): PluginManager {
  return new PluginManager({
    registry: setupRegistryFixtures(),
    scopeConfigs: new LoadedScopeConfigProvider(configs),
  });
}

describe('v0.0.179 PluginManager.getExtensionImpls — membership 模型（核心验证点 1）', () => {
  describe('default scope（全 EP active + 固化 order + exclusive 选 default 项）', () => {
    const mgr = makeManager([DEFAULT_CONFIG]);

    it('context_assemble_reducer（ordered）：5 impl 全 active，按 effective order 升序', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextAssembleReducerPoint);
      const ids = r.map((p) => p.implId);
      expect(ids).toEqual([
        'base_builder', // order=1
        'snip_handler', // order=2
        'orphan_tool_call', // order=3
        'empty_message', // order=4
        'role_merge', // order=5
      ]);
    });

    it('context_ingest_handler（list）：store_sink + system_reminder_injector 都 active', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextIngestHandlerPoint);
      expect(r.map((p) => p.implId).sort()).toEqual(['store_sink', 'system_reminder_injector']);
    });

    it('context_assemble_mapper（list）：transcript_reader + summary_reader 都 active', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextAssembleMapperPoint);
      expect(r.map((p) => p.implId).sort()).toEqual(['summary_reader', 'transcript_reader']);
    });

    it('context_should_compact（exclusive）：选中 threshold_should_compact', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextShouldCompactPoint);
      expect(r).toHaveLength(1);
      expect(r[0]!.implId).toBe('threshold_should_compact');
    });

    it('context_do_compact（exclusive）：选中 summary_do_compact', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextDoCompactPoint);
      expect(r).toHaveLength(1);
      expect(r[0]!.implId).toBe('summary_do_compact');
    });

    it('session_store（exclusive）：选中 persistent_session_store', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(SessionStorePoint);
      expect(r).toHaveLength(1);
      expect(r[0]!.implId).toBe('persistent_session_store');
    });
  });

  describe('forked scope（关 compact + session_store 选 in_memory + 清理 reducer active）', () => {
    const mgr = makeManager([DEFAULT_CONFIG, FORKED_CONFIG]);

    it('context_should_compact（exclusive）：选中 reject_should_compact（防递归）', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextShouldCompactPoint, 'forked');
      expect(r).toHaveLength(1);
      expect(r[0]!.implId).toBe('reject_should_compact');
    });

    it('context_do_compact（exclusive）：选中 noop_do_compact（defense-in-depth）', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextDoCompactPoint, 'forked');
      expect(r).toHaveLength(1);
      expect(r[0]!.implId).toBe('noop_do_compact');
    });

    it('session_store（exclusive）：选中 in_memory_session_store', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(SessionStorePoint, 'forked');
      expect(r).toHaveLength(1);
      expect(r[0]!.implId).toBe('in_memory_session_store');
    });

    it('context_assemble_reducer（ordered）：5 impl 全 active（与 default 对齐，base_builder=1）', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextAssembleReducerPoint, 'forked');
      expect(r.map((p) => p.implId)).toEqual([
        'base_builder', 'snip_handler', 'orphan_tool_call', 'empty_message', 'role_merge',
      ]);
    });

    it('context_ingest_handler（list）：store_sink active，system_reminder_injector 不在 = inactive', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextIngestHandlerPoint, 'forked');
      const ids = r.map((p) => p.implId).sort();
      expect(ids).toEqual(['store_sink']); // system_reminder_injector 不列 = inactive
    });

    it('context_assemble_mapper（list）：transcript_reader + summary_reader 都 active', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextAssembleMapperPoint, 'forked');
      expect(r.map((p) => p.implId).sort()).toEqual(['summary_reader', 'transcript_reader']);
    });
  });

  describe('per-EP 回退（未激活 EP 取 default）', () => {
    const forkedNoIngest: ScopeConfig = {
      ...FORKED_CONFIG,
      // forked 不激活 context_ingest_handler → 回退 default（store_sink + system_reminder_injector 都 active）
      activatedPoints: FORKED_CONFIG.activatedPoints.filter((p) => p !== 'context_ingest_handler'),
    };
    const mgr = makeManager([DEFAULT_CONFIG, forkedNoIngest]);

    it('未激活的 context_ingest_handler → 取 default 视图（system_reminder_injector 也 active）', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextIngestHandlerPoint, 'forked');
      expect(r.map((p) => p.implId).sort()).toEqual(['store_sink', 'system_reminder_injector']);
    });

    it('激活的 context_should_compact → 仍取 forked 自己的（reject）', () => {
      const r = mgr.getExtensionImpls<{ implId: string }>(ContextShouldCompactPoint, 'forked');
      expect(r[0]!.implId).toBe('reject_should_compact');
    });
  });

  describe('exclusive 同 EP 不同 scope 选不同 impl（per-scope 独立）', () => {
    const mgr = makeManager([DEFAULT_CONFIG, FORKED_CONFIG]);

    it('context_should_compact：default 选 threshold / forked 选 reject', () => {
      const d = mgr.getExtensionImpls<{ implId: string }>(ContextShouldCompactPoint, 'default');
      const f = mgr.getExtensionImpls<{ implId: string }>(ContextShouldCompactPoint, 'forked');
      expect(d[0]!.implId).toBe('threshold_should_compact');
      expect(f[0]!.implId).toBe('reject_should_compact');
    });

    it('session_store：default 选 persistent / forked 选 in_memory', () => {
      const d = mgr.getExtensionImpls<{ implId: string }>(SessionStorePoint, 'default');
      const f = mgr.getExtensionImpls<{ implId: string }>(SessionStorePoint, 'forked');
      expect(d[0]!.implId).toBe('persistent_session_store');
      expect(f[0]!.implId).toBe('in_memory_session_store');
    });
  });
});
