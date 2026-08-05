// @vitest-environment jsdom
/**
 * useSkillsCatalog 单测（v0.0.205.t2_cons T3）
 * 参考: specs/ui/components/chat-page/component-skills-modal.md（3 tab 数据源映射）
 *       specs/api/overall/06-skill.md §3.1（GET /skill?sessionId= 四层合并 catalog）
 *
 * 覆盖：
 *   - groupSkillsByScope 纯函数：workspace→session / group→group / builtin+app→global 且只留 enabled
 *   - 挂载 GET-once：listSkillsBySession(sessionId) 调一次，groups 写入；无 SSE 无 poll（不 startTimer）
 *   - refetch() → 重新 GET
 *   - GET 失败 → error 通道
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + __dirname 派生绝对路径 mock
 * api-client；useLifecycle 本身不 mock（真实跑，验证 hook 端到端行为）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SkillEntry } from '../../../lib/api-client';

const apiMocks = vi.hoisted(() => ({ listSkillsBySession: vi.fn() }));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/api-client'));

vi.mock(apiPath, () => apiMocks);

import { useSkillsCatalog, groupSkillsByScope } from '../use-skills-catalog';

function mkSkill(name: string, scope: SkillEntry['scope'], enabled = true): SkillEntry {
  return { name, description: `desc-${name}`, scope, skillDir: `/x/${name}`, enabled };
}

/** 排空 hook 挂载后异步副作用（onInit await），act 内结算 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  apiMocks.listSkillsBySession.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('groupSkillsByScope — 纯函数分组规则', () => {
  it('workspace→session / group→group / builtin+app→global', () => {
    const groups = groupSkillsByScope([
      mkSkill('ws-skill', 'workspace'),
      mkSkill('team-skill', 'group'),
      mkSkill('builtin-skill', 'builtin'),
      mkSkill('app-skill', 'app'),
    ]);
    expect(groups.session.map((s) => s.name)).toEqual(['ws-skill']);
    expect(groups.group.map((s) => s.name)).toEqual(['team-skill']);
    expect(groups.global.map((s) => s.name)).toEqual(['builtin-skill', 'app-skill']);
  });

  it('global 组只留 enabled=true（disabled 的 builtin/app 被过滤）', () => {
    const groups = groupSkillsByScope([
      mkSkill('on-builtin', 'builtin', true),
      mkSkill('off-builtin', 'builtin', false),
      mkSkill('on-app', 'app', true),
      mkSkill('off-app', 'app', false),
    ]);
    expect(groups.global.map((s) => s.name)).toEqual(['on-builtin', 'on-app']);
  });

  it('session/group 组不过滤 enabled（disabled 也展示）', () => {
    const groups = groupSkillsByScope([
      mkSkill('ws-off', 'workspace', false),
      mkSkill('team-off', 'group', false),
    ]);
    expect(groups.session.map((s) => s.name)).toEqual(['ws-off']);
    expect(groups.group.map((s) => s.name)).toEqual(['team-off']);
  });

  it('playground 场景（无 group 层 entries）→ group 恒空', () => {
    const groups = groupSkillsByScope([mkSkill('a', 'workspace'), mkSkill('b', 'app')]);
    expect(groups.group).toEqual([]);
  });
});

describe('useSkillsCatalog — 挂载 GET-once', () => {
  it('mount → listSkillsBySession(sessionId) 调一次，groups 按 scope 分组写入', async () => {
    apiMocks.listSkillsBySession.mockResolvedValue([
      mkSkill('ws-skill', 'workspace'),
      mkSkill('team-skill', 'group'),
      mkSkill('app-on', 'app', true),
      mkSkill('app-off', 'app', false),
    ]);
    const { result } = renderHook(() => useSkillsCatalog('s1'));
    await settle();
    expect(apiMocks.listSkillsBySession).toHaveBeenCalledTimes(1);
    expect(apiMocks.listSkillsBySession).toHaveBeenCalledWith('s1');
    expect(result.current.groups.session.map((s) => s.name)).toEqual(['ws-skill']);
    expect(result.current.groups.group.map((s) => s.name)).toEqual(['team-skill']);
    expect(result.current.groups.global.map((s) => s.name)).toEqual(['app-on']);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('GET 失败 → error 通道承载，groups 恒空', async () => {
    apiMocks.listSkillsBySession.mockRejectedValue(new Error('HTTP 404'));
    const { result } = renderHook(() => useSkillsCatalog('s1'));
    await settle();
    expect(result.current.error).toBe('HTTP 404');
    expect(result.current.groups).toEqual({ session: [], group: [], global: [] });
  });

  it('refetch() → 重新 GET（弹层每次打开刷新语义）', async () => {
    apiMocks.listSkillsBySession.mockResolvedValue([mkSkill('a', 'app')]);
    const { result } = renderHook(() => useSkillsCatalog('s1'));
    await settle();
    expect(apiMocks.listSkillsBySession).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.refetch();
    });
    expect(apiMocks.listSkillsBySession).toHaveBeenCalledTimes(2);
  });

  it('无 poll：推进 120s 无新增 GET（GET-once 契约）', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useSkillsCatalog('s1'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(apiMocks.listSkillsBySession).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(apiMocks.listSkillsBySession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sessionId 变化 → 重新 GET（deps=[sessionId]）', async () => {
    const { rerender } = renderHook(({ sid }) => useSkillsCatalog(sid), { initialProps: { sid: 's1' } });
    await settle();
    expect(apiMocks.listSkillsBySession).toHaveBeenCalledWith('s1');
    rerender({ sid: 's2' });
    await settle();
    expect(apiMocks.listSkillsBySession).toHaveBeenCalledWith('s2');
    expect(apiMocks.listSkillsBySession).toHaveBeenCalledTimes(2);
  });
});
