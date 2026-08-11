/**
 * @vitest-environment jsdom
 * section-team-sync 导出选择器单测（v0.0.321 D2）
 * 参考: specs/tech/version_logs/v0.0.321/change_plan.md D2（导出选择器）
 *       specs/prd/v0.0.321-team-export-picker.md UC-1..UC-5 / §5 边界
 *
 * 覆盖（test-plan §2 UT 组 5 新增）：
 *   - 点导出 → 弹 modal + 列表渲染（团队名 + N 个成员）
 *   - 默认选中最近活跃（当前 squadId ?? 列表第一项）
 *   - 选中 → 确定 → exportSquad(selectedId) + 关闭 modal + flash
 *   - 取消 → 关闭不下载
 *   - 加载失败 → 错误态 + 重试
 *   - 空态（无团队）
 *   - 仅 1 团队仍弹层（不短路）
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { SectionTeamSync } from '../section-team-sync';

const SQUADS = [
  { id: 'SQUAD-A', name: '团队A', memberCount: 5 },
  { id: 'SQUAD-B', name: '团队B', memberCount: 3 },
];

function resJson(body: unknown, status = 200): Response {
  return {
    ok: status < 400, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * fetch mock：/session?biz=studio → studio 会话（带 squadId）；/squad → 团队列表。
 * @param studioSquadId 有值 = 当前会话所属团队（默认选中它）；undefined = 无 studio 会话
 * @param squads listSquads 返回的团队列表
 * @param failSquads true = listSquads 抛错（错误态）
 */
function mockFetch(studioSquadId: string | undefined, squads: typeof SQUADS, failSquads = false): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/session?biz=studio')) {
      return resJson({ items: studioSquadId ? [{ id: 'SESSION-1', squadId: studioSquadId }] : [] });
    }
    if (url.endsWith('/squad')) {
      if (failSquads) return resJson({ error: 'load failed' }, 500);
      return resJson({ items: squads });
    }
    return resJson({}, 404);
  });
}

/** spy <a> 创建：捕获 exportSquad 的下载触发 */
function spyAnchorClick(): ReturnType<typeof vi.fn> {
  const clickSpy = vi.fn();
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = origCreate(tag);
    if (tag === 'a') el.click = clickSpy;
    return el;
  });
  return clickSpy;
}

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SectionTeamSync — 导出选择器（v0.0.321）', () => {
  it('点导出 → 弹 modal，列表渲染团队名 + 成员数，默认高亮最近活跃（当前 squadId）', async () => {
    mockFetch('SQUAD-A', SQUADS);
    render(<SectionTeamSync />);
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('team-sync-export-btn'));

    // modal 打开 + loading → 列表
    await waitFor(() => expect(screen.getByTestId('export-picker-modal')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('export-picker-list')).not.toBeNull());
    expect(screen.getByText('选择要导出的团队')).not.toBeNull();
    expect(screen.getByText('团队A')).not.toBeNull();
    expect(screen.getByText('5 个成员')).not.toBeNull();
    expect(screen.getByText('团队B')).not.toBeNull();
    expect(screen.getByText('3 个成员')).not.toBeNull();
    // 默认选中 SQUAD-A（当前会话团队）
    expect((screen.getByTestId('export-picker-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
    // 点击团队B → 高亮切换
    fireEvent.click(screen.getByTestId('export-picker-item-SQUAD-B'));
    expect(screen.getByTestId('export-picker-item-SQUAD-B').className).toContain('border-accent');
  });

  it('无 studio 会话但列表有团队 → 默认选中列表第一项（最近活跃）', async () => {
    mockFetch(undefined, SQUADS);
    render(<SectionTeamSync />);
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('team-sync-export-btn'));

    await waitFor(() => expect(screen.getByTestId('export-picker-list')).not.toBeNull());
    expect(screen.getByTestId('export-picker-item-SQUAD-A').className).toContain('border-accent');
    expect((screen.getByTestId('export-picker-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('选中 → 确定 → exportSquad(selectedId) 触发下载 + 关闭 modal + flash', async () => {
    mockFetch('SQUAD-A', SQUADS);
    const clickSpy = spyAnchorClick();
    render(<SectionTeamSync />);
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('team-sync-export-btn'));
    await waitFor(() => expect(screen.getByTestId('export-picker-list')).not.toBeNull());

    // 选团队B → 确定 → 下载 B
    fireEvent.click(screen.getByTestId('export-picker-item-SQUAD-B'));
    fireEvent.click(screen.getByTestId('export-picker-confirm-btn'));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // 下载链接指向 SQUAD-B
    const createdAnchors = (document.createElement as ReturnType<typeof vi.fn>).mock.results
      .map((r: { value?: unknown }) => r.value as HTMLElement)
      .filter((el: HTMLElement | undefined) => el?.tagName === 'A');
    expect(createdAnchors.some((a) => (a as HTMLAnchorElement).href.includes('/squad/SQUAD-B/export'))).toBe(true);
    // modal 关闭 + flash
    await waitFor(() => expect(screen.queryByTestId('export-picker-modal')).toBeNull());
    expect(screen.getByTestId('team-sync-toast')).not.toBeNull();
  });

  it('取消 → 关闭 modal 不下载', async () => {
    mockFetch('SQUAD-A', SQUADS);
    const clickSpy = spyAnchorClick();
    render(<SectionTeamSync />);
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('team-sync-export-btn'));
    await waitFor(() => expect(screen.getByTestId('export-picker-list')).not.toBeNull());

    fireEvent.click(screen.getByText('取消', { selector: '[data-action-key="common.confirm-modal.cancel"]' }));
    await waitFor(() => expect(screen.queryByTestId('export-picker-modal')).toBeNull());
    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('team-sync-toast')).toBeNull();
  });

  it('加载失败 → 错误态 + 重试按钮；重试成功恢复列表', async () => {
    mockFetch('SQUAD-A', SQUADS, true);
    render(<SectionTeamSync />);
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('team-sync-export-btn'));

    await waitFor(() => expect(screen.getByTestId('export-picker-error')).not.toBeNull());
    // 错误文案 = 后端 error 字段（fetch mock 返回 'load failed'）
    expect(screen.getByText('load failed')).not.toBeNull();
    expect((screen.getByTestId('export-picker-confirm-btn') as HTMLButtonElement).disabled).toBe(true);

    // 重试成功（fetch mock 切换为成功）
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/session?biz=studio')) return resJson({ items: [{ id: 'S', squadId: 'SQUAD-A' }] });
      if (url.endsWith('/squad')) return resJson({ items: SQUADS });
      return resJson({}, 404);
    });
    fireEvent.click(screen.getByTestId('export-picker-retry-btn'));
    await waitFor(() => expect(screen.getByTestId('export-picker-list')).not.toBeNull());
  });

  it('空态：无团队 → 显示空文案，确定 disabled', async () => {
    mockFetch('SQUAD-A', []);
    render(<SectionTeamSync />);
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('team-sync-export-btn'));

    await waitFor(() => expect(screen.getByTestId('export-picker-empty')).not.toBeNull());
    expect(screen.getByText('没有可导出的团队')).not.toBeNull();
    expect((screen.getByTestId('export-picker-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('仅 1 团队仍弹层（不短路），默认高亮唯一团队可导出', async () => {
    mockFetch(undefined, [SQUADS[0]!]);
    render(<SectionTeamSync />);
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('team-sync-export-btn'));

    await waitFor(() => expect(screen.getByTestId('export-picker-list')).not.toBeNull());
    expect(screen.getByTestId('export-picker-item-SQUAD-A').className).toContain('border-accent');
    expect((screen.getByTestId('export-picker-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('取消竞态：loading 中取消 → listSquads 慢 resolve 不重弹 modal（MAJOR-1）', async () => {
    // listSquads 返回手动控制的 deferred promise（模拟网络慢）
    let resolveSquads!: (v: Response) => void;
    const squadsPromise = new Promise<Response>((resolve) => { resolveSquads = resolve; });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/session?biz=studio')) return resJson({ items: [{ id: 'S', squadId: 'SQUAD-A' }] });
      if (url.endsWith('/squad')) return squadsPromise; // 慢 resolve
      return resJson({}, 404);
    });
    render(<SectionTeamSync />);
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('team-sync-export-btn'));
    // loading 态出现
    await waitFor(() => expect(screen.getByTestId('export-picker-loading')).not.toBeNull());
    // 取消 → modal 关闭
    fireEvent.click(screen.getByText('取消', { selector: '[data-action-key="common.confirm-modal.cancel"]' }));
    await waitFor(() => expect(screen.queryByTestId('export-picker-modal')).toBeNull());
    // 旧请求 resolve → 不得重弹 modal
    resolveSquads(resJson({ items: SQUADS }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('export-picker-modal')).toBeNull();
  });

  it('会话 squadId 不在列表（团队已删）→ 默认选中列表第一项（MINOR-1）', async () => {
    mockFetch('SQUAD-DELETED', SQUADS);
    render(<SectionTeamSync />);
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('team-sync-export-btn'));

    await waitFor(() => expect(screen.getByTestId('export-picker-list')).not.toBeNull());
    // 不指向已删除的 SQUAD-DELETED；默认高亮列表第一项 SQUAD-A
    expect(screen.getByTestId('export-picker-item-SQUAD-A').className).toContain('border-accent');
    expect((screen.getByTestId('export-picker-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
  });
});
