// @vitest-environment jsdom
/**
 * component-squad-status-modal 单测 —— Squad 成员状态弹层（v0.0.269 自 entry 改造）
 * 参考: specs/ui/components/studio-page/component-squad-status-modal.md（组件契约）
 *       specs/tech/version_logs/v0.0.269/change_plan.md（决策③④：入口拆解 + 防套娃）
 *
 * 覆盖：
 *   - running/idle 分区（running 上 idle 下 + 区标题计数）；行 testid=squad-status-row-{memberId}
 *   - 行内容：MemberAvatar 首字母 + name + role 标识（leader/mate）+ presence 文字
 *     （currentWork.text 优先 / i18n fallback studio:seats.status.*）
 *   - 防套娃（v0.0.269 D9）：currentMemberId 命中行不渲染进入对话 icon；其他行渲染（opacity 占位）
 *   - 点击行 → onEnterChat（buildMemberChatNode 组装 ChatNode：sessionId/title/tag）
 *   - 无 deployed 成员空态；detail null → loading
 *   - 打开（挂载）调一次 refreshDetail（fire-and-forget）
 *   - 关闭三路：右上关闭按钮 / 遮罩点击 / Esc → onClose
 *
 * mock 策略：不 mock 组件内部（真实 i18n/MemberAvatar/Portal）；数据经 SquadStatusContext.Provider
 *   注入（useSquadStatus 真实读 Context）。member/detail 构造复用 ./_fixtures。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { SessionState } from '../../chat-page/types';
import type { SquadDetail } from '../squad-types';
import { SquadStatusContext } from '../squad-status-context';
import { mkMember, mkDetail } from './_fixtures';
import { ComponentSquadStatusModal } from '../component-squad-status-modal';
import { PanelRowView } from '../component-member-roster-list';
import type { PanelRow } from '../squad-status-utils';

beforeAll(async () => {
  await initI18n('zh-CN');
});

/** 构造 Provider value（detail + memberStateMap + 回调） */
function mkCtx(over: {
  detail?: SquadDetail | null;
  stateMap?: Record<string, SessionState>;
  onEnterChat?: ReturnType<typeof vi.fn>;
  refreshDetail?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    detail: over.detail === undefined ? mkDetail() : over.detail,
    memberStateMap: over.stateMap ?? {},
    onEnterChat: over.onEnterChat ?? vi.fn(),
    refreshDetail: over.refreshDetail ?? vi.fn(),
  };
}

/** 渲染（Provider 包裹）+ 返回 onClose spy */
function renderModal(
  ctx: ReturnType<typeof mkCtx>,
  props: { onClose?: () => void; currentMemberId?: string } = {},
) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <SquadStatusContext.Provider value={ctx as never}>
      <ComponentSquadStatusModal onClose={onClose} currentMemberId={props.currentMemberId} />
    </SquadStatusContext.Provider>,
  );
  return { onClose };
}

afterEach(() => cleanup());

describe('ComponentSquadStatusModal — running/idle 分区 + 行内容', () => {
  it('running 上 / idle 下分区；行 testid 按 memberId', () => {
    renderModal(
      mkCtx({
        detail: mkDetail({
          members: [
            mkMember({ id: 'leader1', name: 'Rocky', role: 'leader', sessionId: 'sess-leader' }),
            mkMember({ id: 'm2', name: '张三', role: 'mate', sessionId: 'sess-m2' }),
          ],
        }),
        stateMap: { 'sess-leader': 'running', 'sess-m2': 'idle' },
      }),
    );
    expect(screen.getByText('running · 1')).toBeTruthy();
    expect(screen.getByText('idle · 1')).toBeTruthy();
    expect(screen.getByTestId('squad-status-row-leader1')).toBeTruthy();
    expect(screen.getByTestId('squad-status-row-m2')).toBeTruthy();
  });

  it('行内容：name + role 标识 + presence 文字（currentWork 优先）', () => {
    renderModal(
      mkCtx({
        detail: mkDetail({
          members: [
            mkMember({
              id: 'leader1',
              name: 'Rocky',
              role: 'leader',
              sessionId: 'sess-leader',
              currentWork: { text: '正在评审 PR', updatedAt: '2026-08-06T00:00:00Z' },
            }),
          ],
        }),
        stateMap: { 'sess-leader': 'running' },
      }),
    );
    expect(screen.getByText('Rocky')).toBeTruthy();
    expect(screen.getByText('leader')).toBeTruthy(); // role 标识（studio:role.leader）
    expect(screen.getByText('正在评审 PR')).toBeTruthy(); // currentWork 优先
  });

  it('无 currentWork → presence i18n fallback（idle → seats.status.online）', () => {
    renderModal(
      mkCtx({
        detail: mkDetail({
          members: [mkMember({ id: 'm2', name: '张三', sessionId: 'sess-m2' })],
        }),
        stateMap: { 'sess-m2': 'idle' },
      }),
    );
    expect(screen.getByText('张三')).toBeTruthy();
    expect(screen.getByText('mate')).toBeTruthy();
    expect(screen.getByText('在线待命')).toBeTruthy(); // studio:seats.status.online
  });
});

describe('ComponentSquadStatusModal — 防套娃（v0.0.269 D9）', () => {
  it('currentMemberId 命中行不渲染进入对话 icon；其他行渲染（opacity 占位）', () => {
    renderModal(
      mkCtx({
        detail: mkDetail({
          members: [
            mkMember({ id: 'leader1', name: 'Rocky', role: 'leader', sessionId: 'sess-leader' }),
            mkMember({ id: 'm2', name: '张三', role: 'mate', sessionId: 'sess-m2' }),
          ],
        }),
        stateMap: { 'sess-leader': 'running', 'sess-m2': 'idle' },
      }),
      { currentMemberId: 'leader1' },
    );
    const selfRow = screen.getByTestId('squad-status-row-leader1');
    const otherRow = screen.getByTestId('squad-status-row-m2');
    // 注意：running 行 SpinnerRing 也带 aria-hidden，chat icon 容器以 opacity-0 区分（SpinnerRing 无）
    expect(selfRow.querySelector('span.opacity-0')).toBeNull(); // 防套娃：不渲染 icon
    expect(otherRow.querySelector('span.opacity-0')).toBeTruthy(); // 其他行渲染（hover opacity 切换）
  });

  it('currentMemberId undefined（群聊/无当前 chat 上下文）→ 全部行显示 icon', () => {
    renderModal(
      mkCtx({
        detail: mkDetail({
          members: [mkMember({ id: 'm2', name: '张三', sessionId: 'sess-m2' })],
        }),
      }),
    );
    const row = screen.getByTestId('squad-status-row-m2');
    expect(row.querySelector('span[aria-hidden]')).toBeTruthy();
  });
});

describe('ComponentSquadStatusModal — 进入对话 + 状态', () => {
  it('点击行 → onEnterChat（buildMemberChatNode 组装 ChatNode）', () => {
    const onEnterChat = vi.fn();
    renderModal(
      mkCtx({
        detail: mkDetail({
          members: [mkMember({ id: 'm2', name: '张三', sessionId: 'sess-m2' })],
        }),
        onEnterChat,
      }),
    );
    fireEvent.click(screen.getByTestId('squad-status-row-m2'));
    expect(onEnterChat).toHaveBeenCalledTimes(1);
    const node = onEnterChat.mock.calls[0]![0] as { sessionId: string; title: string; tag: string };
    expect(node.sessionId).toBe('sess-m2');
    expect(node.title).toBe('张三');
    expect(node.tag).toContain('Alpha 小队'); // tagSingle（studio:squadTree.tagSingle）
  });

  it('无 deployed 成员（全 benched）→ 空态文案', () => {
    renderModal(
      mkCtx({
        detail: mkDetail({
          members: [mkMember({ id: 'b1', state: 'benched' })],
        }),
      }),
    );
    expect(screen.getByText(/暂无成员/)).toBeTruthy(); // studio:seats.emptyMembers
  });

  it('detail null（未就绪）→ loading', () => {
    renderModal(mkCtx({ detail: null }));
    expect(screen.getByText('加载中…')).toBeTruthy(); // common:status.loading
  });

  it('打开（挂载）调一次 refreshDetail（fire-and-forget）', () => {
    const refreshDetail = vi.fn();
    renderModal(mkCtx({ refreshDetail }));
    expect(refreshDetail).toHaveBeenCalledTimes(1);
  });
});

describe('ComponentSquadStatusModal — 关闭三路', () => {
  it('右上关闭按钮 → onClose', () => {
    const { onClose } = renderModal(mkCtx());
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('遮罩点击 → onClose', () => {
    const { onClose } = renderModal(mkCtx());
    // 内层 shell 的父元素 = 遮罩（fixed inset-0 backdrop）
    fireEvent.click(screen.getByTestId('squad-status-modal').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc → onClose', () => {
    const { onClose } = renderModal(mkCtx());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('无 Provider（直接渲染不包 Provider）→ 不渲染（fail-safe 双保险）', () => {
    const onClose = vi.fn();
    render(<ComponentSquadStatusModal onClose={onClose} currentMemberId="m1" />);
    expect(screen.queryByTestId('squad-status-modal')).toBeNull();
  });
});

describe('ComponentSquadStatusModal — [v0.0.278] running 动态 + idle 弱化', () => {
  /** 构造 PanelRow（直接渲染 PanelRowView 验证，含 offline 防御场景） */
  function mkRow(over: Partial<PanelRow> = {}): PanelRow {
    return {
      member: mkMember({ id: 'm2', name: '张三', sessionId: 'sess-m2' }),
      isLeader: false,
      presence: 'online',
      statusTextSource: { kind: 'fallback' },
      ...over,
    };
  }

  /** 直接渲染 PanelRowView（variant 显式传入，验证分区身份逻辑） */
  function renderRow(row: PanelRow, variant: 'running' | 'idle' | 'benched' = 'running') {
    const onEnterChat = vi.fn();
    render(
      <PanelRowView row={row} currentMemberId={undefined} onEnterChat={onEnterChat} variant={variant} />,
    );
    return { onEnterChat };
  }

  it('running 分区行渲染 SpinnerRing（animate-spin 动态标识）且不弱化', () => {
    renderModal(
      mkCtx({
        detail: mkDetail({
          members: [mkMember({ id: 'leader1', name: 'Rocky', role: 'leader', sessionId: 'sess-leader' })],
        }),
        stateMap: { 'sess-leader': 'running' },
      }),
    );
    const row = screen.getByTestId('squad-status-row-leader1');
    // SpinnerRing = accent 旋转环（animate-spin），shrink-0 占位防位移
    expect(row.querySelector('.animate-spin')).toBeTruthy();
    // running 行不弱化：行根无 opacity-[0.85]
    expect(row.className).not.toContain('opacity-[0.85]');
  });

  it('idle 分区行整体变灰：行根 opacity-[0.85] + title text-fg-2 + badge/avatar 色块降透明度', () => {
    renderModal(
      mkCtx({
        detail: mkDetail({
          members: [mkMember({ id: 'm2', name: '张三', sessionId: 'sess-m2' })],
        }),
        stateMap: { 'sess-m2': 'idle' },
      }),
    );
    const row = screen.getByTestId('squad-status-row-m2');
    expect(row.className).toContain('opacity-[0.85]'); // 行根弱化
    expect(row.querySelector('.animate-spin')).toBeNull(); // idle 无 spinner
    // title（成员名）文字变灰 text-fg-2
    expect(screen.getByText('张三').className).toContain('text-fg-2');
    // role badge 色块降透明度（bg-bg-warm → bg-bg-warm/50）
    const badge = row.querySelector('span.font-mono');
    expect(badge?.className).toContain('bg-bg-warm/50');
    // avatar 色卡容器额外降透明度（叠乘行根 opacity）
    expect(row.querySelector('span.opacity-70')).toBeTruthy();
  });

  it('suspended（presence=busy 但非 running）idle 分区也弱化（277 口径含 suspended）', () => {
    renderRow(mkRow({ presence: 'busy' }), 'idle');
    const row = screen.getByTestId('squad-status-row-m2');
    expect(row.className).toContain('opacity-[0.85]');
  });

  it('offline 行不叠加 idle 弱化（防御：弹层 derivePanelRows 已过滤 benched，实际无 offline 行）', () => {
    renderRow(mkRow({ presence: 'offline' }), 'idle');
    const row = screen.getByTestId('squad-status-row-m2');
    expect(row.className).not.toContain('opacity-[0.85]'); // offline 不叠加
    expect(row.querySelector('.animate-spin')).toBeNull(); // idle 分区 → 无 spinner
  });

  it('running 行（variant=running）无弱化 + spinner 在（PanelRowView 直接验证）', () => {
    renderRow(mkRow({ presence: 'busy' }), 'running');
    const row = screen.getByTestId('squad-status-row-m2');
    expect(row.className).not.toContain('opacity-[0.85]');
    expect(row.querySelector('.animate-spin')).toBeTruthy();
  });
});
