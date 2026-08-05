/**
 * LoadedGroupMetaProvider 单测（白盒）—— GroupMeta[] → 运行时读视图
 * 参考: specs/tech/plugin_system/[P1]groups_meta_decl.md §3.3（包装层）
 *       specs/tech/version_logs/v0.0.71/change_plan.md 模块 1
 *
 * 覆盖：
 *   - listGroups：声明序透传 + slice 副本（外部修改不影响内部）
 *   - getGroupByPoint：pointId → 所属 group（O(1) Map 查询）
 *   - getGroupById：groupId → 元数据
 *   - 构建期校验：重复 pointId throw（含同 group 内重复）/ 重复 groupId throw（D6 前置）
 *   - 真实 app/plugins/groups.json 经 Loader → Provider 链路冒烟
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { LoadedGroupMetaProvider } from '../group-meta-provider';
import type { GroupMeta } from '../group-meta-loader';
import { GroupMetaLoader } from '../group-meta-loader';

function makeGroup(id: string, extPoints: string[]): GroupMeta {
  return {
    id,
    label: `__MSG_group.${id}.label__`,
    description: `__MSG_group.${id}.description__`,
    extPoints,
  };
}

describe('LoadedGroupMetaProvider — listGroups / getGroupByPoint / getGroupById', () => {
  it('listGroups 按声明序返回（slice 副本，外部修改不影响内部）', () => {
    const g1 = makeGroup('g1', ['p1']);
    const g2 = makeGroup('g2', ['p2']);
    const provider = new LoadedGroupMetaProvider([g1, g2]);
    const list = provider.listGroups();
    expect(list.map((g) => g.id)).toEqual(['g1', 'g2']);
    // 修改返回数组不影响内部
    list.pop();
    expect(provider.listGroups()).toHaveLength(2);
  });

  it('getGroupByPoint 返回所属 group', () => {
    const g1 = makeGroup('g1', ['p1', 'p2']);
    const g2 = makeGroup('g2', ['p3']);
    const provider = new LoadedGroupMetaProvider([g1, g2]);
    expect(provider.getGroupByPoint('p1')?.id).toBe('g1');
    expect(provider.getGroupByPoint('p2')?.id).toBe('g1');
    expect(provider.getGroupByPoint('p3')?.id).toBe('g2');
  });

  it('getGroupByPoint 未登记返 undefined', () => {
    const provider = new LoadedGroupMetaProvider([makeGroup('g1', ['p1'])]);
    expect(provider.getGroupByPoint('unknown')).toBeUndefined();
  });

  it('getGroupById 返回元数据', () => {
    const g1 = makeGroup('g1', ['p1']);
    const provider = new LoadedGroupMetaProvider([g1]);
    expect(provider.getGroupById('g1')).toBe(g1);
  });

  it('getGroupById 未登记返 undefined', () => {
    const provider = new LoadedGroupMetaProvider([makeGroup('g1', ['p1'])]);
    expect(provider.getGroupById('unknown')).toBeUndefined();
  });

  it('空 groups 数组合法（listGroups 返 []）', () => {
    const provider = new LoadedGroupMetaProvider([]);
    expect(provider.listGroups()).toEqual([]);
    expect(provider.getGroupByPoint('p1')).toBeUndefined();
    expect(provider.getGroupById('g1')).toBeUndefined();
  });
});

describe('LoadedGroupMetaProvider — 构建期校验（D6 唯一性前置）', () => {
  it('重复 groupId → throw', () => {
    expect(() =>
      new LoadedGroupMetaProvider([
        makeGroup('g1', ['p1']),
        makeGroup('g1', ['p2']),
      ]),
    ).toThrow(/重复 group id "g1"/);
  });

  it('重复 pointId（跨 group）→ throw', () => {
    expect(() =>
      new LoadedGroupMetaProvider([
        makeGroup('g1', ['p1']),
        makeGroup('g2', ['p1']), // p1 重复
      ]),
    ).toThrow(/重复 pointId "p1"/);
  });

  it('重复 pointId（同 group 内）→ throw', () => {
    expect(() =>
      new LoadedGroupMetaProvider([
        makeGroup('g1', ['p1', 'p1']), // 同 group 内重复
      ]),
    ).toThrow(/重复 pointId "p1"/);
  });
});

describe('LoadedGroupMetaProvider — 真实 app/plugins/groups.json 链路冒烟', () => {
  it('Loader.load() → LoadedGroupMetaProvider 构造成功（真实 10 group + 17 EP 不触发构建期 throw，含 context_clean_view_reducer）', () => {
    const realPath = path.join(__dirname, '../../../../plugins/groups.json');
    const file = new GroupMetaLoader(realPath).load();
    const provider = new LoadedGroupMetaProvider(file.groups);
    expect(provider.listGroups()).toHaveLength(10);
    // 17 EP 都能查到所属 group
    const allPoints = provider.listGroups().flatMap((g) => g.extPoints);
    expect(allPoints).toHaveLength(17);
    for (const p of allPoints) {
      expect(provider.getGroupByPoint(p)).toBeDefined();
    }
    // 10 group 都能按 id 查到
    for (const g of provider.listGroups()) {
      expect(provider.getGroupById(g.id)?.id).toBe(g.id);
    }
  });

  it('真实 groups.json: getGroupByPoint("llm_provider").id === "provider"', () => {
    const realPath = path.join(__dirname, '../../../../plugins/groups.json');
    const provider = new LoadedGroupMetaProvider(
      new GroupMetaLoader(realPath).load().groups,
    );
    expect(provider.getGroupByPoint('llm_provider')?.id).toBe('provider');
    expect(provider.getGroupByPoint('llm_protocol')?.id).toBe('provider');
    expect(provider.getGroupByPoint('web_search_provider')?.id).toBe('web');
    expect(provider.getGroupByPoint('session_store')?.id).toBe('context-engine');
    expect(provider.getGroupByPoint('context_ingest_handler')?.id).toBe('context-ingest');
    expect(provider.getGroupByPoint('system_reminder')?.id).toBe('context-ingest');
    expect(provider.getGroupByPoint('context_assemble_mapper')?.id).toBe('context-assemble');
    expect(provider.getGroupByPoint('context_assemble_reducer')?.id).toBe('context-assemble');
    expect(provider.getGroupByPoint('context_clean_view_reducer')?.id).toBe('context-assemble');
    expect(provider.getGroupByPoint('context_should_compact')?.id).toBe('context-compact');
    expect(provider.getGroupByPoint('context_do_compact')?.id).toBe('context-compact');
    expect(provider.getGroupByPoint('context_post_compact')?.id).toBe('context-compact');
    expect(provider.getGroupByPoint('system_prompt_mapper')?.id).toBe('system-prompt');
    expect(provider.getGroupByPoint('system_prompt_reducer')?.id).toBe('system-prompt');
  });
});
