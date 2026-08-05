/**
 * @vitest-environment jsdom
 * component-derive-academy-picker 单测 —— v0.0.233 继承预览面板 + 裁决交互
 * 参考: app/web/src/components/academy-page/component-derive-academy-picker.tsx
 *       specs/ui/components/academy-page/component-derive-academy-picker.md
 *       specs/api/overall/11a-squad-endpoints.md §2.1（resolution schema）+ §2.5（PreviewResult）
 *
 * 覆盖（task.json acceptanceCriteria）：
 *   - preview loading/error → 派生按钮 disabled；ready → enabled
 *   - toggle 切换 action：同名项默认 skip，开 toggle → overwrite
 *   - onConfirm 产 resolution（per-item 同名清单）；无同名项 → undefined
 *   - onPreviewStateChange 上抛 status + resolution
 *   - 不同名项无 toggle（固定槽位 invisible 占位，_conventions §11）
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { ComponentDeriveAcademyPicker } from '../component-derive-academy-picker';
import type { PreviewResult } from '../../../lib/squad-api';
import type { DeriveResolution } from '../../studio-page/squad-types';

// 绝对路径 mock（memory: test-vitest-mock-absolute-path）—— bun+jsdom 全量并发下相对路径静默失效
const { hookPath, usePreviewMock } = vi.hoisted(() => ({
  hookPath: require('node:path').resolve(__dirname, '../use-derive-academy-preview.ts'),
  usePreviewMock: vi.fn(),
}));

vi.mock(hookPath, () => ({
  useDeriveAcademyPreview: (...args: unknown[]) => usePreviewMock(...args),
}));

import type { DeriveClassroomOption, DeriveStudentOption } from '../component-derive-academy-picker';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => {
  cleanup();
  usePreviewMock.mockReset();
});

const CLASSROOM: DeriveClassroomOption = {
  id: 'cls-1', name: '教室A', logo: '🎓', logoBg: 'var(--hue-violet-bg)', studentCount: 2,
};
const STUDENT: DeriveStudentOption = {
  id: 'stu-1', name: '小明', latestVersionId: 'ver-1', latestVersionLabel: 'v2.0', recommended: true,
};

function mkPreview(overrides: Partial<PreviewResult> = {}): PreviewResult {
  return {
    agentsMd: { exists: true },
    skills: [{ name: 'writer', sameNameConflict: false }],
    memory: [{ name: 'style', sameNameConflict: false }],
    ...overrides,
  };
}

/** 渲染 picker（非 embedded，含确认/取消按钮）；返回挂载到组件上的回调 */
function renderPicker(preview: { status: 'idle' | 'loading' | 'ready' | 'error'; data?: PreviewResult; error?: string }) {
  usePreviewMock.mockReturnValue(preview);
  const onConfirm = vi.fn();
  const onPreviewStateChange = vi.fn();
  render(
    <ComponentDeriveAcademyPicker
      squadId="squad-1"
      classrooms={[CLASSROOM]}
      students={[STUDENT]}
      selectedClassroomId="cls-1"
      selectedStudentId="stu-1"
      onPickClassroom={() => {}}
      onPickStudent={() => {}}
      onCancel={() => {}}
      onConfirm={onConfirm}
      onPreviewStateChange={onPreviewStateChange}
    />,
  );
  return { onConfirm, onPreviewStateChange };
}

/** 派生按钮（getByRole 返回 HTMLElement，cast 到 HTMLButtonElement 取 .disabled） */
function confirmBtn(): HTMLButtonElement {
  return screen.getByRole('button', { name: /派生为成员/ }) as HTMLButtonElement;
}

describe('ComponentDeriveAcademyPicker — 派生按钮 disabled 直到 preview 就绪', () => {
  it('preview loading → 派生按钮 disabled', () => {
    renderPicker({ status: 'loading' });
    expect(confirmBtn().disabled).toBe(true);
  });

  it('preview error → 派生按钮 disabled + 错误兜底文案', () => {
    renderPicker({ status: 'error', error: '失败' });
    expect(confirmBtn().disabled).toBe(true);
    expect(screen.getByText(/继承预检失败/)).toBeTruthy();
  });

  it('preview ready → 派生按钮 enabled', () => {
    renderPicker({ status: 'ready', data: mkPreview() });
    expect(confirmBtn().disabled).toBe(false);
  });
});

describe('ComponentDeriveAcademyPicker — 同名裁决 toggle + resolution', () => {
  it('同名项默认 skip：onConfirm 产 resolution 含 action=skip', () => {
    const data = mkPreview({
      skills: [
        { name: 'writer', sameNameConflict: false },
        { name: 'shared-skill', sameNameConflict: true },
      ],
      memory: [{ name: 'shared-mem', sameNameConflict: true }],
    });
    const { onConfirm } = renderPicker({ status: 'ready', data });
    fireEvent.click(screen.getByRole('button', { name: /派生为成员/ }));
    expect(onConfirm).toHaveBeenCalledWith({
      skills: [{ name: 'shared-skill', action: 'skip' }],
      memory: [{ name: 'shared-mem', action: 'skip' }],
    });
  });

  it('toggle 开 = overwrite：翻转同名 skill 后 onConfirm 产 action=overwrite', () => {
    const data = mkPreview({
      skills: [{ name: 'shared-skill', sameNameConflict: true }],
      memory: [],
    });
    const { onConfirm } = renderPicker({ status: 'ready', data });
    // 默认 toggle off = skip；开 toggle = overwrite
    const toggle = screen.getByRole('switch', { name: /覆盖 shared-skill/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /派生为成员/ }));
    expect(onConfirm).toHaveBeenCalledWith({
      skills: [{ name: 'shared-skill', action: 'overwrite' }],
    });
  });

  it('toggle 再关回 skip（skip ↔ overwrite 双向）', () => {
    const data = mkPreview({ skills: [{ name: 's', sameNameConflict: true }], memory: [] });
    const { onConfirm } = renderPicker({ status: 'ready', data });
    const toggle = screen.getByRole('switch', { name: /覆盖 s/ });
    fireEvent.click(toggle); // on
    fireEvent.click(toggle); // off
    fireEvent.click(screen.getByRole('button', { name: /派生为成员/ }));
    expect(onConfirm).toHaveBeenCalledWith({ skills: [{ name: 's', action: 'skip' }] });
  });

  it('无同名项 → onConfirm(undefined)：无 resolution 字段（后端默认全 merge）', () => {
    const data = mkPreview({ skills: [{ name: 'a', sameNameConflict: false }], memory: [] });
    const { onConfirm } = renderPicker({ status: 'ready', data });
    fireEvent.click(screen.getByRole('button', { name: /派生为成员/ }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('不同名项无 toggle 开关（_conventions §11 固定槽位不位移）', () => {
    const data = mkPreview({ skills: [{ name: 'noconflict', sameNameConflict: false }], memory: [] });
    renderPicker({ status: 'ready', data });
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('ComponentDeriveAcademyPicker — onPreviewStateChange 上抛', () => {
  it('ready 时上抛 status + resolution（无同名项 → undefined）', async () => {
    const data = mkPreview({ skills: [{ name: 'a', sameNameConflict: false }], memory: [] });
    const { onPreviewStateChange } = renderPicker({ status: 'ready', data });
    await waitFor(() => {
      expect(onPreviewStateChange).toHaveBeenCalled();
    });
    const lastCall = onPreviewStateChange.mock.calls.at(-1)![0] as { status: string; resolution?: DeriveResolution };
    expect(lastCall.status).toBe('ready');
    expect(lastCall.resolution).toBeUndefined();
  });

  it('loading / error 时上抛 resolution=undefined', async () => {
    const { onPreviewStateChange } = renderPicker({ status: 'loading' });
    await waitFor(() => expect(onPreviewStateChange).toHaveBeenCalled());
    const lastCall = onPreviewStateChange.mock.calls.at(-1)![0] as { status: string; resolution?: DeriveResolution };
    expect(lastCall.status).toBe('loading');
    expect(lastCall.resolution).toBeUndefined();
  });

  it('ready + 同名项 toggle on → 上抛 resolution 含 overwrite', async () => {
    const data = mkPreview({ skills: [{ name: 'x', sameNameConflict: true }], memory: [] });
    const { onPreviewStateChange } = renderPicker({ status: 'ready', data });
    await waitFor(() => expect(onPreviewStateChange).toHaveBeenCalled());
    // 初始上抛 skip
    const initial = onPreviewStateChange.mock.calls.at(-1)![0] as { resolution?: DeriveResolution };
    expect(initial.resolution?.skills?.[0]).toEqual({ name: 'x', action: 'skip' });
    // 翻 toggle → 上抛 overwrite
    fireEvent.click(screen.getByRole('switch', { name: /覆盖 x/ }));
    await waitFor(() => {
      const last = onPreviewStateChange.mock.calls.at(-1)![0] as { resolution?: DeriveResolution };
      expect(last.resolution?.skills?.[0]).toEqual({ name: 'x', action: 'overwrite' });
    });
  });
});
