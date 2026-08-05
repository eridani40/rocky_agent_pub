/**
 * @vitest-environment jsdom
 * use-derive-academy-preview 单测 —— derive_academy 继承预检 hook 三态 + 竞态守卫
 * 参考: app/web/src/components/academy-page/use-derive-academy-preview.ts
 *       specs/api/overall/11a-squad-endpoints.md §2.5（PreviewResult = 消费契约）
 *
 * 覆盖（task.json acceptanceCriteria）：
 *   - source 三字段缺 → idle 不发请求（避免无谓请求）
 *   - loading → ready（成功三态）
 *   - loading → error（失败三态，不抛给组件展示）
 *   - source 切换竞态：旧请求 cancelled，不把旧结果写入新 source
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// 绝对路径 mock（memory: test-vitest-mock-absolute-path）—— bun+jsdom 全量并发下相对路径静默失效
const { squadApiPath, previewMock } = vi.hoisted(() => ({
  squadApiPath: require('node:path').resolve(__dirname, '../../../lib/squad-api.ts'),
  previewMock: vi.fn(),
}));

vi.mock(squadApiPath, () => ({
  previewDeriveAcademy: (...args: Parameters<typeof previewMock>) => previewMock(...args),
}));

import { useDeriveAcademyPreview } from '../use-derive-academy-preview';
import type { PreviewResult } from '../../../lib/squad-api';

/** 造一个 PreviewResult（可定制同名项） */
function mkPreview(overrides: Partial<PreviewResult> = {}): PreviewResult {
  return {
    agentsMd: { exists: true },
    skills: [{ name: 'writer', sameNameConflict: false }],
    memory: [{ name: 'style', sameNameConflict: false }],
    ...overrides,
  };
}

const FULL_SOURCE = { classroomId: 'cls-1', studentId: 'stu-1', versionId: 'ver-1' };

describe('useDeriveAcademyPreview', () => {
  beforeEach(() => {
    previewMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('source undefined → idle 不发请求', () => {
    const { result } = renderHook(() => useDeriveAcademyPreview('squad-1', undefined));
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('source 字段缺（versionId 空）→ idle 不发请求', () => {
    const { result } = renderHook(() =>
      useDeriveAcademyPreview('squad-1', { classroomId: 'cls-1', studentId: 'stu-1', versionId: '' }),
    );
    expect(result.current.status).toBe('idle');
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('loading → ready：成功三态', async () => {
    const data = mkPreview();
    previewMock.mockResolvedValue(data);
    const { result } = renderHook(() => useDeriveAcademyPreview('squad-1', FULL_SOURCE));

    // 发起即 loading
    await waitFor(() => {
      expect(result.current.status).toBe('loading');
    });
    // 落定 ready + data
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.data).toEqual(data);
    expect(result.current.error).toBeUndefined();
    expect(previewMock).toHaveBeenCalledWith('squad-1', FULL_SOURCE);
  });

  it('loading → error：失败三态，不抛，error 兜底文案', async () => {
    previewMock.mockRejectedValue(new Error('HTTP 400 invalid_academy_source'));
    const { result } = renderHook(() => useDeriveAcademyPreview('squad-1', FULL_SOURCE));

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toContain('invalid_academy_source');
  });

  it('source 切换竞态：旧请求 cancelled，新 source 不写旧结果', async () => {
    // 旧 source 请求慢（50ms 后 resolve 旧 data）
    const oldData = mkPreview({ skills: [{ name: 'old-skill', sameNameConflict: false }] });
    previewMock.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(oldData), 50)),
    );
    // 新 source 请求快（立即 resolve 新 data）
    const newData = mkPreview({ skills: [{ name: 'new-skill', sameNameConflict: true }] });
    previewMock.mockImplementationOnce(() => Promise.resolve(newData));

    const source2 = { classroomId: 'cls-1', studentId: 'stu-1', versionId: 'ver-2' };
    const { result, rerender } = renderHook(
      ({ source }) => useDeriveAcademyPreview('squad-1', source),
      { initialProps: { source: FULL_SOURCE } },
    );

    // 切到新 source（旧请求尚未 resolve）
    rerender({ source: source2 });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    // 关键：data 是新 source 的 new-skill，不是旧 source 的 old-skill（旧请求被 cancelled 丢弃）
    expect(result.current.data?.skills[0]!.name).toBe('new-skill');
  });
});
