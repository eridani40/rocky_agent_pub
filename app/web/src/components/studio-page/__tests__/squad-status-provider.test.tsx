/**
 * @vitest-environment jsdom
 * squad-status-provider 单测 —— v0.0.268 SquadStatusContext Provider（决策② selector 精化）
 * 参考: specs/tech/version_logs/v0.0.268/change_plan.md 决策② + acceptanceCriteria 第 4 条
 *
 * 覆盖：
 *   - memberStateMap 只含成员 sessionId 子集（非成员 sid 不进）
 *   - 值比较稳定引用：非成员 session SSE（stateMap 引用变但成员子集值不变）→ 引用不变
 *     （StudioChatRouter memo 不 re-render 的前提）
 *   - 成员 state 变 → 引用变（入口 re-render）
 *   - detail 成员增删 → 键集变 → 引用变
 *   - refreshDetail 调 reloadDetail(selectedSquadId)（fire-and-forget）
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { initI18n } from '../../../i18n';
import { SquadStatusProvider } from '../squad-status-provider';
import { useSquadStatus } from '../squad-status-context';
import { mkMember, mkDetail } from './_fixtures';
import type { SessionState } from '../../chat-page/types';

beforeAll(async () => {
  await initI18n('zh-CN');
});
beforeEach(() => cleanup());
afterEach(() => cleanup());

/** probe 组件：把 memberStateMap 引用 + 键集记录到外部数组（断言引用稳定性） */
const refs: Record<string, SessionState>[] = [];
const keys: string[] = [];
function Probe() {
  const ctx = useSquadStatus();
  useEffect(() => {
    if (ctx) {
      refs.push(ctx.memberStateMap);
      keys.push(Object.keys(ctx.memberStateMap).join(','));
    }
  });
  return <div data-testid="probe">{ctx ? Object.keys(ctx.memberStateMap).join(',') : 'no-ctx'}</div>;
}

/** 渲染 Provider + Probe；rerender 换 stateMap/detail */
function setup(detail: ReturnType<typeof mkDetail> | null, stateMap: Record<string, SessionState>) {
  const onEnterChat = vi.fn();
  const reloadDetail = vi.fn(async () => {});
  const { rerender } = render(
    <SquadStatusProvider detail={detail} stateMap={stateMap} onEnterChat={onEnterChat} reloadDetail={reloadDetail} selectedSquadId="s1">
      <Probe />
    </SquadStatusProvider>,
  );
  return {
    rerender: (nextDetail: ReturnType<typeof mkDetail> | null, nextStateMap: Record<string, SessionState>) =>
      rerender(
        <SquadStatusProvider detail={nextDetail} stateMap={nextStateMap} onEnterChat={onEnterChat} reloadDetail={reloadDetail} selectedSquadId="s1">
          <Probe />
        </SquadStatusProvider>,
      ),
    onEnterChat,
    reloadDetail,
  };
}

/** 取最近一次记录的引用（index = 当前已渲染次数 - 1） */
function lastRef(): Record<string, SessionState> | undefined {
  return refs[refs.length - 1];
}

describe('SquadStatusProvider — memberStateMap 派生（只含成员子集 + 值比较稳定引用）', () => {
  beforeEach(() => {
    refs.length = 0;
    keys.length = 0;
  });

  it('只含成员 sessionId 子集（非成员 sid 不进）', () => {
    const detail = mkDetail({
      members: [mkMember({ id: 'leader1', sessionId: 'sess-l', state: 'deployed' })],
    });
    setup(detail, { 'sess-l': 'running' as SessionState, 'sess-other': 'running' as SessionState });
    expect(keys[0]).toBe('sess-l'); // 非成员 sess-other 被过滤
  });

  it('非成员 session SSE（stateMap 引用变但成员子集值不变）→ memberStateMap 引用不变', () => {
    const detail = mkDetail({
      members: [mkMember({ id: 'leader1', sessionId: 'sess-l', state: 'deployed' })],
    });
    const { rerender } = setup(detail, { 'sess-l': 'running' as SessionState });
    const ref1 = lastRef();
    // 非成员 SSE：stateMap 新对象（含非成员键），成员子集值不变 → 引用应保持
    rerender(detail, { 'sess-l': 'running' as SessionState, 'sess-other': 'idle' as SessionState });
    expect(lastRef()).toBe(ref1); // 引用不变（memo 不 re-render 前提）
    expect(keys[1]).toBe('sess-l'); // 键集仍只有成员
  });

  it('成员 state 变 → memberStateMap 引用变（入口 re-render）', () => {
    const detail = mkDetail({
      members: [mkMember({ id: 'leader1', sessionId: 'sess-l', state: 'deployed' })],
    });
    const { rerender } = setup(detail, { 'sess-l': 'running' as SessionState });
    const ref1 = lastRef();
    rerender(detail, { 'sess-l': 'idle' as SessionState });
    expect(lastRef()).not.toBe(ref1); // 成员值变 → 新引用
    expect(keys[1]).toBe('sess-l');
  });

  it('detail 成员增删 → 键集变 → 引用变', () => {
    const detail1 = mkDetail({
      members: [mkMember({ id: 'leader1', sessionId: 'sess-l', state: 'deployed' })],
    });
    const { rerender } = setup(detail1, { 'sess-l': 'running' as SessionState });
    const ref1 = lastRef();
    const detail2 = mkDetail({
      members: [
        mkMember({ id: 'leader1', sessionId: 'sess-l', state: 'deployed' }),
        mkMember({ id: 'm2', sessionId: 'sess-2', state: 'deployed' }),
      ],
    });
    rerender(detail2, { 'sess-l': 'running' as SessionState, 'sess-2': 'idle' as SessionState });
    expect(lastRef()).not.toBe(ref1); // 键集变 → 新引用
    expect(keys[1]).toBe('sess-l,sess-2');
  });

  it('detail=null → memberStateMap 保持 lastRef（不崩）', () => {
    const detail = mkDetail({
      members: [mkMember({ id: 'leader1', sessionId: 'sess-l', state: 'deployed' })],
    });
    const { rerender } = setup(detail, { 'sess-l': 'running' as SessionState });
    const ref1 = lastRef();
    rerender(null, {});
    expect(lastRef()).toBe(ref1); // null 时返 lastRef
  });
});

describe('SquadStatusProvider — refreshDetail / value 注入', () => {
  it('refreshDetail 调 reloadDetail(selectedSquadId)（fire-and-forget）', () => {
    const reloadDetail = vi.fn(async () => {});
    const ConsumeBtn = () => {
      const ctx = useSquadStatus();
      return (
        <button type="button" data-testid="refresh-btn" onClick={() => ctx?.refreshDetail()}>
          refresh
        </button>
      );
    };
    render(
      <SquadStatusProvider detail={mkDetail()} stateMap={{}} onEnterChat={vi.fn()} reloadDetail={reloadDetail} selectedSquadId="s1">
        <ConsumeBtn />
      </SquadStatusProvider>,
    );
    fireEvent.click(screen.getByTestId('refresh-btn'));
    expect(reloadDetail).toHaveBeenCalledWith('s1');
  });

  it('detail=null 时 refreshDetail 不调（selectedSquadId null 守卫）', () => {
    const reloadDetail = vi.fn(async () => {});
    const ConsumeBtn = () => {
      const ctx = useSquadStatus();
      return (
        <button type="button" data-testid="refresh-btn" onClick={() => ctx?.refreshDetail()}>
          refresh
        </button>
      );
    };
    render(
      <SquadStatusProvider detail={mkDetail()} stateMap={{}} onEnterChat={vi.fn()} reloadDetail={reloadDetail} selectedSquadId={null}>
        <ConsumeBtn />
      </SquadStatusProvider>,
    );
    fireEvent.click(screen.getByTestId('refresh-btn'));
    expect(reloadDetail).not.toHaveBeenCalled();
  });

  it('无 Provider 时 useSquadStatus 返 null（fail-safe 前提）', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('no-ctx');
  });
});
