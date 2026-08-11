/**
 * @vitest-environment jsdom
 * section-team-sync 单测（v0.0.319 团队同步页）
 * 参考: specs/prd/v0.0.319-team-sync.md §2.2/§2.3（导出/导入流程）
 *       specs/tech/version_logs/v0.0.319/change_plan.md D7
 *       specs/tech/version_logs/v0.0.321/change_plan.md D2（导出选择器）
 *
 * 覆盖（test-plan §2 UT 组 5）：
 *   - landing 态：当前团队名 + 导出/导入入口按钮渲染
 *   - 无 squadId（playground session）→ 导出按钮仍可点（弹层选团队）+ 提示
 *   - 导入 preview 成功 → 预览页（manifest 信息 + 团队名输入框预填 + 重名提示）
 *   - 导入确认 modal 展示；确认 → execute 成功 → flash + 回 landing
 *   - preview 失败（无效 zip）→ 错误 flash，停留 landing
 *
 * [v0.0.321] 导出选择器用例拆到 section-team-sync-export-picker.test.tsx（单文件 ≤300 行）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { SectionTeamSync } from '../section-team-sync';

const MANIFEST = {
  slug: 'orig', name: '源团队', description: 'd', leaderName: 'Darvin', builtin: false,
  members: [{ name: 'coder', intro: '代码开发者', skillConfig: { mode: 'inherit', overrides: {} } }],
};

function resJson(body: unknown, status = 200): Response {
  // previewImport/executeImport 用 res.json()；listSquads/listStudioSessions 走 req() 用 res.text()——两者都要实现
  return {
    ok: status < 400, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * [v0.0.319 ET 修复] 组件 squadId 来源 = listStudioSessions（GET /session?biz=studio）
 * 按 updatedAt desc 首项带 squadId 者。UT 用 fetch mock 该端点控制「有无团队会话」两种态。
 * @param squadId 有值 = 存在团队会话（导出可用）；undefined = 无 studio 会话（导出 disabled）
 */
function mockStudioSessions(squadId?: string): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/session?biz=studio')) {
      const items = squadId ? [{ id: 'SESSION-1', squadId }] : [];
      return resJson({ items });
    }
    if (url.includes('/squad/import?step=preview')) return resJson({ importKey: 'KEY-1', manifest: MANIFEST });
    if (url.includes('/squad/import?step=execute')) return resJson({ squadId: 'NEW-1', created: ['coder'], failed: [] });
    if (url.endsWith('/squad')) return resJson({ items: [] }); // 重名检测默认无重名
    return resJson({}, 404);
  });
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

describe('SectionTeamSync — landing 态', () => {
  it('渲染导出/导入入口按钮；有团队会话时导出可点', async () => {
    mockStudioSessions('SQUAD-1');
    render(<SectionTeamSync />);
    // squadId 经 useEffect + fetch 异步解析 → waitFor 等按钮 enabled
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('team-sync-import-btn')).not.toBeNull();
  });

  it('无团队会话 → 导出按钮仍可点（弹层选团队）+ 提示文案', async () => {
    mockStudioSessions(undefined);
    render(<SectionTeamSync />);
    // 拉取完成后 squadId 仍 undefined → 仍显示提示，但导出可点（v0.0.321：弹层选团队）
    await waitFor(() => expect(screen.getByTestId('team-sync-no-squad-hint')).not.toBeNull());
    expect((screen.getByTestId('team-sync-export-btn') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('SectionTeamSync — import 流程', () => {
  function chooseFile(): void {
    const input = screen.getByTestId('team-sync-file-input');
    const file = new File(['zip'], 'team.zip', { type: 'application/zip' });
    fireEvent.change(input, { target: { files: [file] } });
  }

  it('preview 成功 → 预览页（manifest 信息 + 团队名预填 + 重名提示）', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/session?biz=studio')) return resJson({ items: [{ id: 'SESSION-1', squadId: 'SQUAD-1' }] });
      if (url.includes('/squad/import?step=preview')) return resJson({ importKey: 'KEY-1', manifest: MANIFEST });
      if (url.endsWith('/squad')) return resJson({ items: [{ id: 'X', name: '源团队' }] }); // 重名
      return resJson({}, 404);
    });
    render(<SectionTeamSync />);
    chooseFile();

    await waitFor(() => expect(screen.getByTestId('team-sync-preview')).not.toBeNull());
    expect((screen.getByTestId('team-sync-name-input') as HTMLInputElement).value).toBe('源团队');
    // manifest 信息卡（leader + 成员）
    expect(screen.getByTestId('team-sync-preview').textContent).toContain('Darvin');
    expect(screen.getByTestId('team-sync-preview').textContent).toContain('coder');
    // 重名提示
    await waitFor(() => expect(screen.getByTestId('team-sync-dup-warning')).not.toBeNull());
  });

  it('确认 modal → execute 成功 → flash + 回 landing 态', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/session?biz=studio')) return resJson({ items: [{ id: 'SESSION-1', squadId: 'SQUAD-1' }] });
      if (url.includes('step=preview')) return resJson({ importKey: 'KEY-1', manifest: MANIFEST });
      if (url.includes('step=execute')) return resJson({ squadId: 'NEW-1', created: ['coder'], failed: [] });
      if (url.endsWith('/squad')) return resJson({ items: [] });
      return resJson({}, 404);
    });
    render(<SectionTeamSync />);
    chooseFile();
    await waitFor(() => expect(screen.getByTestId('team-sync-preview')).not.toBeNull());

    // 点导入 → 确认 modal
    fireEvent.click(screen.getByTestId('team-sync-confirm-import-btn'));
    expect(screen.getByRole('dialog')).not.toBeNull();

    // 确认 → execute → flash + 回 landing
    fireEvent.click(screen.getByText('导入', { selector: '[data-action-key="common.confirm-modal.confirm"]' }));
    await waitFor(() => expect(screen.queryByTestId('team-sync-preview')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('team-sync-toast')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('team-sync-imported-hint')).not.toBeNull());
    // execute 请求带 x-session-id
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const execCall = calls.find(([u]) => String(u).includes('step=execute'));
    expect((execCall![1] as RequestInit).headers).toMatchObject({ 'x-session-id': 'SESSION-1' });
  });

  it('preview 失败（无效 zip）→ 错误 flash，停留 landing', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ error: '文件已损坏，无法解压' }, 400),
    );
    render(<SectionTeamSync />);
    chooseFile();
    await waitFor(() => expect(screen.getByTestId('team-sync-toast').textContent).toContain('文件已损坏'));
    expect(screen.queryByTestId('team-sync-preview')).toBeNull();
  });

  it('团队名为空 → 导入按钮 disabled', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/session?biz=studio')) return resJson({ items: [{ id: 'SESSION-1', squadId: 'SQUAD-1' }] });
      if (url.includes('step=preview')) return resJson({ importKey: 'KEY-1', manifest: MANIFEST });
      if (url.endsWith('/squad')) return resJson({ items: [] });
      return resJson({}, 404);
    });
    render(<SectionTeamSync />);
    chooseFile();
    await waitFor(() => expect(screen.getByTestId('team-sync-preview')).not.toBeNull());
    fireEvent.change(screen.getByTestId('team-sync-name-input'), { target: { value: '  ' } });
    await waitFor(() =>
      expect((screen.getByTestId('team-sync-confirm-import-btn') as HTMLButtonElement).disabled).toBe(true));
  });
});
