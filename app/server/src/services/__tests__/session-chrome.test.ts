/**
 * session-chrome 服务 UT（v0.0.216 T1）
 * 参考: specs/api/overall/04a-session-chrome.md §2/§3/§4
 *
 * 覆盖：
 *   - deriveChromeKind 全 kind 判定序（studio group/member、academy 三 role、缺省 playground）
 *   - buildSessionChrome 各 kind defaultModel 数据源映射（appConfig / squad / classroom）
 *   - 数据源缺失/异常降级 null/[]（绝不 throw）
 *   - sessionModel 保留字/空 → null；readOnly 覆盖层；同构 shape（字段集恒定）
 *   - CAPABILITIES 静态表（studio_group 差异 + 其余全开 + 无 subagent 单列）
 */
import { describe, it, expect } from 'vitest';
import {
  deriveChromeKind, buildSessionChrome, CAPABILITIES,
  type ChromeSessionSource, type SessionChromeSources, type ChromeKind,
} from '../session-chrome';

/** 空数据源（全部缺数据 → 降级路径） */
function emptySources(): SessionChromeSources {
  return {
    appConfig: { get: () => undefined },
    squadStore: { getSquad: async () => undefined },
    memberStore: { listMembers: async () => [] },
    academyStore: { getClassroom: async () => undefined },
  };
}

/** 最小 session literal（playground 缺省形） */
function mkSession(over: Partial<ChromeSessionSource> = {}): ChromeSessionSource {
  return { id: 'sid-1', title: 't', ...over };
}

describe('deriveChromeKind（api 04a §3.1 判定序）', () => {
  it('studio + squad → studio_group；studio + leader/mate → studio_member', () => {
    expect(deriveChromeKind({ biz: 'studio', role: 'squad' })).toBe('studio_group');
    expect(deriveChromeKind({ biz: 'studio', role: 'leader' })).toBe('studio_member');
    expect(deriveChromeKind({ biz: 'studio', role: 'mate' })).toBe('studio_member');
  });

  it('academy 三 role → academy_head/coach/student', () => {
    expect(deriveChromeKind({ biz: 'academy', role: 'head_teacher' })).toBe('academy_head');
    expect(deriveChromeKind({ biz: 'academy', role: 'coach' })).toBe('academy_coach');
    expect(deriveChromeKind({ biz: 'academy', role: 'student' })).toBe('academy_student');
  });

  it('其余（playground / biz 缺省 / academy 非法 role 组合）→ playground', () => {
    expect(deriveChromeKind({ biz: 'playground', role: 'rocky' })).toBe('playground');
    expect(deriveChromeKind({})).toBe('playground');
    expect(deriveChromeKind({ biz: 'academy', role: 'rocky' })).toBe('playground');
  });
});

describe('CAPABILITIES 静态表（api 04a §4）', () => {
  const allOpen = {
    runState: true, hitl: true, enqueue: true, effortPicker: true, approvalPicker: true,
    usage: true, compact: true, clear: true, minimap: true, floatMenu: true, cron: true,
    groupRender: false,
  };

  it('studio_group：关 runState/enqueue/两 picker/cron + groupRender=true（v0.0.152 裁决）', () => {
    expect(CAPABILITIES.studio_group).toEqual({
      ...allOpen,
      runState: false, enqueue: false, effortPicker: false, approvalPicker: false, cron: false,
      groupRender: true,
    });
  });

  it('其余 5 kind 全开 + groupRender=false（academy 全开=用户拍板）', () => {
    const openKinds: ChromeKind[] = [
      'playground', 'studio_member', 'academy_head', 'academy_coach', 'academy_student',
    ];
    for (const k of openKinds) expect(CAPABILITIES[k], k).toEqual(allOpen);
  });

  it('无 subagent 单列（readOnly 是覆盖层）：表键集 = 6 kind', () => {
    expect(Object.keys(CAPABILITIES).sort()).toEqual([
      'academy_coach', 'academy_head', 'academy_student',
      'playground', 'studio_group', 'studio_member',
    ]);
  });
});

describe('buildSessionChrome — defaultModel 各 kind 数据源映射（§3.2）', () => {
  it('playground → app_config.default_models.default.chat（modelId only）', async () => {
    const deps = emptySources();
    deps.appConfig = {
      get: (g, k) => (g === 'default_models' && k === 'default' ? { chat: 'app-chat' } : undefined),
    };
    const view = await buildSessionChrome(mkSession(), deps);
    expect(view.kind).toBe('playground');
    expect(view.defaultModel).toEqual({ modelId: 'app-chat' });
    expect(view.members).toEqual([]);
    expect(view.memberId).toBeNull();
    expect(view.tag).toBe('');
  });

  it('studio_member → squad.modelDefault + providerId；members 投影 + tag "squad · role" + memberId', async () => {
    const deps = emptySources();
    deps.squadStore = {
      getSquad: async () => ({ name: 'S队', modelDefault: 'sq-m', modelDefaultProviderId: 'prov-1' }),
    };
    deps.memberStore = {
      listMembers: async () => [
        { id: 'm1', name: 'Alice', role: 'leader' },
        { id: 'm2', name: 'Bob', role: 'mate' },
      ],
    };
    const view = await buildSessionChrome(
      mkSession({ biz: 'studio', role: 'leader', squadId: 'sq1', memberId: 'm1' }), deps,
    );
    expect(view.kind).toBe('studio_member');
    expect(view.defaultModel).toEqual({ providerId: 'prov-1', modelId: 'sq-m' });
    expect(view.members).toEqual([
      { id: 'm1', name: 'Alice', role: 'leader' },
      { id: 'm2', name: 'Bob', role: 'mate' },
    ]);
    expect(view.memberId).toBe('m1');
    expect(view.tag).toBe('S队 · leader');
  });

  it('studio_group → tag "squad · 群聊"，memberId 恒 null', async () => {
    const deps = emptySources();
    deps.squadStore = { getSquad: async () => ({ name: 'S队', modelDefault: 'sq-m' }) };
    const view = await buildSessionChrome(
      mkSession({ biz: 'studio', role: 'squad', squadId: 'sq1' }), deps,
    );
    expect(view.kind).toBe('studio_group');
    expect(view.tag).toBe('S队 · 群聊');
    expect(view.memberId).toBeNull();
    // squad 无 providerId（存量数据）→ defaultModel 只带 modelId
    expect(view.defaultModel).toEqual({ modelId: 'sq-m' });
  });

  it('academy 三 kind → classroom.defaultModel {providerId?, modelId}', async () => {
    const deps = emptySources();
    deps.academyStore = {
      getClassroom: async () => ({ defaultModel: { providerId: 'prov-a', modelId: 'cls-m' } }),
    };
    for (const role of ['head_teacher', 'coach', 'student'] as const) {
      const view = await buildSessionChrome(
        mkSession({ biz: 'academy', role, academyClassroomId: 'c1' }), deps,
      );
      expect(view.defaultModel, role).toEqual({ providerId: 'prov-a', modelId: 'cls-m' });
      expect(view.members, role).toEqual([]);
      expect(view.tag, role).toBe('');
    }
  });
});

describe('buildSessionChrome — 降级（缺数据 null/[]，绝不 throw）', () => {
  it('studio squad/classroom 不存在 → defaultModel null + tag 空 + members []', async () => {
    const view = await buildSessionChrome(
      mkSession({ biz: 'studio', role: 'leader', squadId: 'gone', memberId: 'm1' }), emptySources(),
    );
    expect(view.defaultModel).toBeNull();
    expect(view.tag).toBe('');
    expect(view.members).toEqual([]);
  });

  it('数据源 throw → 视为缺数据降级（不向上抛）', async () => {
    const deps = emptySources();
    deps.squadStore = { getSquad: async () => { throw new Error('boom'); } };
    deps.memberStore = { listMembers: async () => { throw new Error('boom'); } };
    const view = await buildSessionChrome(
      mkSession({ biz: 'studio', role: 'squad', squadId: 'sq1' }), deps,
    );
    expect(view.defaultModel).toBeNull();
    expect(view.members).toEqual([]);
  });

  it('academy 无 academyClassroomId / default 未配 → null（playground 无 chat 同理）', async () => {
    const a = await buildSessionChrome(
      mkSession({ biz: 'academy', role: 'coach' }), emptySources(),
    );
    expect(a.defaultModel).toBeNull();
    const p = await buildSessionChrome(mkSession(), emptySources());
    expect(p.defaultModel).toBeNull();
  });
});

describe('buildSessionChrome — sessionModel / readOnly / 同构 shape', () => {
  it('sessionModel：保留字 default/none/空 → null；具体值 → {providerId, modelId}', async () => {
    for (const mid of ['default', 'none', '', undefined]) {
      const view = await buildSessionChrome(mkSession({ modelId: mid }), emptySources());
      expect(view.sessionModel, String(mid)).toBeNull();
    }
    const view = await buildSessionChrome(
      mkSession({ providerId: 'p1', modelId: 'm1' }), emptySources(),
    );
    expect(view.sessionModel).toEqual({ providerId: 'p1', modelId: 'm1' });
  });

  it('readOnly = derivation==="subagent"（kind 保留宿主，与 kind 正交）', async () => {
    const sub = await buildSessionChrome(
      mkSession({ biz: 'studio', role: 'mate', derivation: 'subagent' }), emptySources(),
    );
    expect(sub.readOnly).toBe(true);
    expect(sub.kind).toBe('studio_member');
    const parent = await buildSessionChrome(mkSession({ derivation: 'parent' }), emptySources());
    expect(parent.readOnly).toBe(false);
  });

  it('effort/approvalMode 透传；缺省 → null；titled 规范化 boolean', async () => {
    const v1 = await buildSessionChrome(
      mkSession({ effort: 'high', approvalMode: 'greenlight', titled: true }), emptySources(),
    );
    expect(v1.effort).toBe('high');
    expect(v1.approvalMode).toBe('greenlight');
    expect(v1.titled).toBe(true);
    const v2 = await buildSessionChrome(mkSession(), emptySources());
    expect(v2.effort).toBeNull();
    expect(v2.approvalMode).toBeNull();
    expect(v2.titled).toBe(false);
  });

  it('同构承诺：各 kind 字段集恒定（键集合一致）', async () => {
    const kinds: Array<Partial<ChromeSessionSource>> = [
      {},
      { biz: 'studio', role: 'leader', squadId: 'sq1' },
      { biz: 'studio', role: 'squad', squadId: 'sq1' },
      { biz: 'academy', role: 'head_teacher', academyClassroomId: 'c1' },
    ];
    const keySets = await Promise.all(kinds.map(async (over) => {
      const v = await buildSessionChrome(mkSession(over), emptySources());
      return Object.keys(v).sort().join(',');
    }));
    expect(new Set(keySets).size).toBe(1);
  });

  it('capabilities 返回浅拷贝（调用方改动不污染静态表）', async () => {
    const view = await buildSessionChrome(mkSession(), emptySources());
    view.capabilities.runState = false;
    expect(CAPABILITIES.playground.runState).toBe(true);
  });
});
