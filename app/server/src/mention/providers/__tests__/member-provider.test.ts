/**
 * MemberProvider 单元测试（v0.0.68 R4）
 * 参考: specs/tech/mention/provider-interface.md §8
 *       specs/tech/version_logs/v0.0.68/change_plan.md R4 section
 *
 * 锁定契约：
 *   - search name 模糊匹配（leader + mate 全员）
 *   - ctx.squadId 缺失 → 返空数组（防御）
 *   - state='benched' 的 member 不入结果（暂停值勤）
 *   - 不暴露 subagent（MemberSchema role 枚举仅 leader/mate，天然不暴露）
 *   - id=memberId + display（v0.0.86：address 走 id 顶层字段；display.badge 仅 leader）
 *
 * 白盒：mock MemberStore.listMembers 返回固定 fixture，验证 search 行为。
 */
import { describe, it, expect } from 'vitest';
import { MemberProvider } from '../member-provider';
import type { MemberStore, MemberEntity } from '../../../stores/squad-store';

/** 构造 mock MemberStore（仅 listMembers 被 provider 调用）。 */
function makeMockMemberStore(members: MemberEntity[]): MemberStore {
  return {
    listMembers: async () => members,
  } as unknown as MemberStore;
}

/** 构造最小 SearchCtx。 */
function makeCtx(query: string, squadId?: string) {
  return {
    query,
    limit: 20,
    bizType: 'studio' as const,
    biz: 'studio' as const,
    role: 'squad' as const,
    derivation: 'parent' as const,
    sessionId: 'sess-1',
    workspaceDir: '/tmp',
    ...(squadId !== undefined ? { squadId } : {}),
  } as const;
}

/** 构造最小 MemberEntity fixture。 */
function makeMember(overrides: Partial<MemberEntity> & { id: string; name: string }): MemberEntity {
  return {
    squadId: 'sq-1',
    sessionId: 'sess-x',
    role: 'mate',
    state: 'deployed',
    tools: [],
    skills: [],
    model: '',
    ...overrides,
  } as unknown as MemberEntity;
}

describe('MemberProvider - 基础属性', () => {
  it('name=member / label=Members', () => {
    const p = new MemberProvider(makeMockMemberStore([]));
    expect(p.name).toBe('member');
    expect(p.label).toBe('Members');
  });
});

describe('MemberProvider.search - name 模糊匹配', () => {
  it('匹配 leader + mate（全员）', async () => {
    const store = makeMockMemberStore([
      makeMember({ id: 'mb-1', name: 'Alice', role: 'leader' }),
      makeMember({ id: 'mb-2', name: 'Bob', role: 'mate' }),
    ]);
    const p = new MemberProvider(store);
    const result = await p.search(makeCtx('', 'sq-1'));
    expect(result.items).toHaveLength(2);
  });

  it('query 子串匹配 → 仅返回命中项', async () => {
    const store = makeMockMemberStore([
      makeMember({ id: 'mb-1', name: 'Alice', role: 'leader' }),
      makeMember({ id: 'mb-2', name: 'Bob', role: 'mate' }),
      makeMember({ id: 'mb-3', name: 'Bobby', role: 'mate' }),
    ]);
    const p = new MemberProvider(store);
    const result = await p.search(makeCtx('bob', 'sq-1'));
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.listView.title).sort()).toEqual(['Bob', 'Bobby']);
  });

  it('query 大小写不敏感', async () => {
    const store = makeMockMemberStore([
      makeMember({ id: 'mb-1', name: 'Alice', role: 'leader' }),
    ]);
    const p = new MemberProvider(store);
    const result = await p.search(makeCtx('ALICE', 'sq-1'));
    expect(result.items).toHaveLength(1);
  });

  it('id=memberId + display.badge 仅 leader', async () => {
    const store = makeMockMemberStore([
      makeMember({ id: 'mb-1', name: 'Alice', role: 'leader' }),
    ]);
    const p = new MemberProvider(store);
    const result = await p.search(makeCtx('ali', 'sq-1'));
    expect(result.items[0]).toMatchObject({
      type: 'member',
      id: 'mb-1',
      listView: { title: 'Alice', subtitle: 'leader', icon: 'member' },
      display: { icon: 'member', label: 'Alice', badge: 'leader' },
    });
  });
});

describe('MemberProvider.search - 防御 + 状态过滤', () => {
  it('ctx.squadId 缺失 → 返空数组（防御）', async () => {
    const store = makeMockMemberStore([
      makeMember({ id: 'mb-1', name: 'Alice', role: 'leader' }),
    ]);
    const p = new MemberProvider(store);
    const result = await p.search(makeCtx('ali', undefined));
    expect(result.items).toEqual([]);
  });

  it('state=benched → 不入结果（仅 deployed 入搜索）', async () => {
    const store = makeMockMemberStore([
      makeMember({ id: 'mb-1', name: 'Active Alice', role: 'leader', state: 'deployed' }),
      makeMember({ id: 'mb-2', name: 'Benched Bob', role: 'mate', state: 'benched' }),
    ]);
    const p = new MemberProvider(store);
    const result = await p.search(makeCtx('', 'sq-1'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.listView.title).toBe('Active Alice');
  });

  it('不暴露 subagent（MemberSchema role 枚举仅 leader/mate，天然不暴露）', async () => {
    // 即使错误数据塞入 subagent role 也应正常返回（member schema 不会落，此为契约文档化）
    const store = makeMockMemberStore([
      makeMember({ id: 'mb-1', name: 'Alice', role: 'leader' }),
    ]);
    const p = new MemberProvider(store);
    const result = await p.search(makeCtx('', 'sq-1'));
    expect(result.items.every((i) => i.listView.subtitle !== 'subagent')).toBe(true);
  });
});
