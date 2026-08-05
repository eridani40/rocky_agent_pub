// @vitest-environment jsdom
/**
 * CompactBtn 单测（v0.0.54.compaction）
 * 参考: specs/ui/components/chat-page/_overview.md §4.3（CompactBtn 状态绑定）
 *       specs/ui/components/chat-page/component-usage-panel.md §3.3（summaryTask 四态）
 *
 * 覆盖（v0.0.54.compaction 简化后——唯一 disabled = summaryTask running）：
 *   - summaryTask.status='running' → disabled（compact 进行中，唯一 disabled 条件）
 *   - sessionBusy=true（session running）→ NOT disabled（[v0.0.54.compaction] 修订：任何 session.state 都能 compact）
 *   - idle（summaryTask=null + sessionBusy=false）→ 可点，点击触发 onClick
 *   - summaryTask='done'/'failed' + sessionBusy=false → 仍可点（compact 后可再触发）
 *
 * 注意：readOnly 不再隐藏 CompactBtn 是 SectionChatSession 层的逻辑（见
 *       section-chat-session.test.tsx）；本测只覆盖 CompactBtn 组件自身 disabled 不变量。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CompactBtn } from '../component-usage-panel';

afterEach(() => {
  cleanup();
});

describe('CompactBtn — disabled 不变量（v0.0.54.compaction）', () => {
  it('summaryTask=null + sessionBusy=false → 可点，点击触发 onClick', () => {
    const onClick = vi.fn();
    render(<CompactBtn summaryTask={null} sessionBusy={false} onClick={onClick} />);
    const btn = screen.getByRole('button', { name: 'usage.compact' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("summaryTask.status='running' → disabled（compact 进行中，唯一 disabled 条件）", () => {
    const onClick = vi.fn();
    render(
      <CompactBtn
        summaryTask={{ status: 'running', runId: 'r1', startedAt: 't', error: null }}
        sessionBusy={false}
        onClick={onClick}
      />,
    );
    const btn = screen.getByRole('button', { name: 'usage.compact' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // disabled 状态下点击不触发
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('sessionBusy=true（running）→ NOT disabled（[v0.0.54.compaction] 任何 session.state 都能 compact）', () => {
    const onClick = vi.fn();
    render(<CompactBtn summaryTask={null} sessionBusy={true} onClick={onClick} />);
    const btn = screen.getByRole('button', { name: 'usage.compact' }) as HTMLButtonElement;
    // disabled = (summaryTask.status === 'running') —— sessionBusy 不再影响
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("summaryTask='running' + sessionBusy=true → disabled（summaryTask running 优先）", () => {
    const onClick = vi.fn();
    render(
      <CompactBtn
        summaryTask={{ status: 'running', runId: 'r1', startedAt: 't', error: null }}
        sessionBusy={true}
        onClick={onClick}
      />,
    );
    const btn = screen.getByRole('button', { name: 'usage.compact' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("summaryTask='done' + sessionBusy=false → 可点（compact 完成后可再触发）", () => {
    const onClick = vi.fn();
    render(
      <CompactBtn
        summaryTask={{ status: 'done', runId: 'r1', startedAt: 't', error: null }}
        sessionBusy={false}
        onClick={onClick}
      />,
    );
    const btn = screen.getByRole('button', { name: 'usage.compact' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("summaryTask='failed' + sessionBusy=false → 可点（失败后可重试）", () => {
    render(
      <CompactBtn
        summaryTask={{ status: 'failed', runId: null, startedAt: null, error: 'boom' }}
        sessionBusy={false}
        onClick={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: 'usage.compact' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});
