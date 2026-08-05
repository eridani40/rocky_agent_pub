/**
 * default.yaml 加载 → getExtensionImpls 等价性 UT
 * 参考: states/v0.0.179.plugin_config/verify/test-plan.md §UT（迁移等价性，default 部分）
 *
 * v0.0.204 收尾：原 forked.yaml 已删除（commit 9cc8bcdf，拆为 summary + consolidate 基座），
 * forked 相关 7 条迁移等价用例随之删除（dead test for deleted scope）。
 * summary/consolidate 行为覆盖见 scope-extends-chain.test.ts。
 *
 * 保留 default.yaml 验证项：
 *   1. default.yaml 全 EP 激活；exclusive EP 恰好 1 active（threshold/summary/persistent/skills_sh）
 *   2. default.yaml context_ingest_handler 5 项（含 search_indexing + system_reminder_injector）
 *   3. default.yaml ordered EP（assemble_reducer 仅 base_builder；clean_view 6 项）
 *   4. v0.0.206：channel EP 在 default.yaml 激活（plugin scope D6 已删，不配=关）→ feishu 可实例化
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { Registry } from '../registry';
import { PluginManager } from '../plugin-manager';
import { LoadedScopeConfigProvider } from '../scope-config-provider';
import { ScopeConfigLoader } from '../scope-config-loader';
import { BuiltinLoader } from '../builtin-loader';
import {
  BUILTIN_EXTENSION_POINTS,
  ContextIngestHandlerPoint,
  ContextAssembleReducerPoint,
  ContextCleanViewReducerPoint,
  ContextShouldCompactPoint,
  ContextDoCompactPoint,
  SessionStorePoint,
  SkillMarketProviderPoint,
  ChannelPoint,
  type ExtensionPoint,
} from '../extension-point';
import type { Channel } from '../../channel/types';

const REAL_BUILTINS_ROOT = path.join(__dirname, '../../../../plugins/builtins');
const REAL_SCOPES_ROOT = path.join(__dirname, '../../../../plugins/scopes');

async function makeRealManager(): Promise<PluginManager> {
  const registry = new Registry();
  for (const ep of BUILTIN_EXTENSION_POINTS) registry.registerExtensionPoint(ep);
  await new BuiltinLoader(REAL_BUILTINS_ROOT).loadAll(registry);
  const scopeConfigs = new ScopeConfigLoader(REAL_SCOPES_ROOT).loadAll();
  return new PluginManager({
    registry,
    scopeConfigs: new LoadedScopeConfigProvider(scopeConfigs),
  });
}

describe('default.yaml 加载 → getExtensionImpls 等价性', () => {
  it('exclusive EP 各返唯一 active（threshold/summary/persistent/skills_sh）', async () => {
    const mgr = await makeRealManager();
    // context_should_compact (exclusive): threshold_should_compact
    const shouldComp = mgr.getExtensionImpls<{ implId: string }>(ContextShouldCompactPoint);
    expect(shouldComp).toHaveLength(1);
    expect(shouldComp[0]!.implId).toBe('threshold_should_compact');
    // context_do_compact (exclusive): summary_do_compact
    const doComp = mgr.getExtensionImpls<{ implId: string }>(ContextDoCompactPoint);
    expect(doComp).toHaveLength(1);
    expect(doComp[0]!.implId).toBe('summary_do_compact');
    // session_store (exclusive): persistent_session_store
    const session = mgr.getExtensionImpls<{ implId: string }>(SessionStorePoint);
    expect(session).toHaveLength(1);
    expect(session[0]!.implId).toBe('persistent_session_store');
    // skill_market_provider (exclusive): skills_sh（provider 类用 .id 非 .implId，验 length 即可）
    const market = mgr.getExtensionImpls(SkillMarketProviderPoint);
    expect(market).toHaveLength(1);
  });

  it('context_ingest_handler 含 search_indexing + system_reminder_injector（5 项）', async () => {
    const mgr = await makeRealManager();
    const r = mgr.getExtensionImpls<{ implId: string }>(ContextIngestHandlerPoint);
    const ids = r.map((p) => p.implId).sort();
    // search_indexing 必须保留（search.sqlite 唯一 ingest 写入路径）
    expect(ids).toContain('search_indexing');
    expect(ids).toContain('system_reminder_injector');
    expect(ids).toContain('store_sink');
    expect(ids).toContain('query_truncate');
    expect(ids).toContain('tool_result_truncate');
    expect(ids).toHaveLength(5);
  });

  it('ordered EP 返全量 active（assemble_reducer 仅 base_builder；clean_view 8 项，v0.0.207 头插 dedup_tool_result，v0.0.256 第 4 位插 bubble_text_before_tool_call）', async () => {
    const mgr = await makeRealManager();
    const reducers = mgr.getExtensionImpls<{ implId: string }>(ContextAssembleReducerPoint);
    expect(reducers.map((p) => p.implId)).toEqual(['base_builder']);
    const cleanReducers = mgr.getExtensionImpls<{ implId: string }>(ContextCleanViewReducerPoint);
    expect(cleanReducers.map((p) => p.implId)).toEqual([
      'dedup_tool_result', 'snip_handler', 'orphan_tool_call', 'bubble_text_before_tool_call',
      'think_remove', 'fill_empty_text', 'empty_message', 'role_merge',
    ]);
  });

  it('channel EP 在 default.yaml 激活：getExtensionImpls(ChannelPoint, default) 返 1 项 type=feishu（v0.0.206 护栏）', async () => {
    const mgr = await makeRealManager();
    // 防 channel 误删出 default.yaml（plugin scope D6 已删，不配 = 关）+ 验 (implId, cfg) 构造可实例化
    const impls = mgr.getExtensionImpls(ChannelPoint as ExtensionPoint<Channel>, 'default');
    expect(impls).toHaveLength(1);
    expect(impls[0]!.type).toBe('feishu');
  });
});
