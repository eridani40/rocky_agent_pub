/**
 * @vitest-environment jsdom
 * section-classroom-detail 单测 —— 教室 head 默认模型 slot（v0.0.230 无继承契约）
 * 参考: specs/ui/components/academy-page/section-classroom-detail.md
 *       specs/tech/version_logs/v0.0.230/change_plan.md 第 4 行
 *
 * 覆盖（PRD §2.2 UC-230-4/5 + P-B）：
 * - 未配 classroom.defaultModel → trigger 显「选择 model」占位；打开 picker 无「跟随应用默认」项
 * - 配 defaultModel → trigger 显 `provider / model`（formatModelDisplay 口径）
 * - 在 picker 选具体模型 → patchClassroom(classroomId, { defaultModel: sel })（PATCH 语义保留）
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { __setProvidersCacheForTest, __resetProvidersCacheForTest } from '../../../lib/providers';
import type { ClassroomDetail } from '../../../lib/academy-types';

// 绝对路径 mock（memory: test-vitest-mock-absolute-path）
const { sectionChatSessionPath, academyApiPath, chatProps } = vi.hoisted(() => ({
  sectionChatSessionPath: require('node:path').resolve(__dirname, '../../chat-page/section-chat-session.tsx'),
  academyApiPath: require('node:path').resolve(__dirname, '../../../lib/academy-api'),
  chatProps: { current: null as Record<string, unknown> | null },
}));

vi.mock(sectionChatSessionPath, () => ({
  SectionChatSession: (props: Record<string, unknown>) => {
    chatProps.current = props;
    return null;
  },
}));
vi.mock(academyApiPath, () => ({
  createStudent: vi.fn(),
  getStudentDetail: vi.fn(),
  patchClassroom: vi.fn(),
}));

import { SectionClassroomDetail } from '../section-classroom-detail';
import { patchClassroom } from '../../../lib/academy-api';

beforeAll(async () => {
  await initI18n('zh-CN');
});
beforeEach(() => {
  cleanup();
  chatProps.current = null;
  localStorage.clear();
  vi.mocked(patchClassroom).mockClear();
  __resetProvidersCacheForTest();
});
afterEach(() => {
  cleanup();
  __resetProvidersCacheForTest();
});

/** 构造教室详情 fixture（students 空 → 补拉 effect 无网络依赖） */
function makeDetail(defaultModel?: { providerId?: string; modelId: string }): ClassroomDetail {
  return {
    classroom: {
      id: 'c1',
      name: '一班',
      headTeacherSessionId: 's-head',
      defaultModel,
    },
    students: [],
    tasks: [],
    datasets: [],
    graders: [],
  };
}

function renderDetail(detail: ClassroomDetail) {
  return render(
    <SectionClassroomDetail
      classroomId="c1"
      detail={detail}
      onRefresh={() => {}}
      onOpenStudent={() => {}}
    />,
  );
}

describe('SectionClassroomDetail 教室 head 默认模型 slot（v0.0.230 无继承）', () => {
  it('未配 defaultModel → trigger 显「选择 model」占位；打开 picker 无「跟随应用默认」项', async () => {
    __setProvidersCacheForTest([{ id: 'p1', label: 'MiniMax', models: [{ modelId: 'glm-5.2', label: 'glm-5.2' }] }]);
    renderDetail(makeDetail(undefined));
    // trigger 显占位（无 inheritLabel → ModelPicker 既有「选择 model」）
    const trigger = screen.getByRole('button', { name: '选择 model' });
    expect(trigger.textContent).toContain('选择 model');
    // 打开 picker：extraTopItems=undefined → 无「跟随应用默认」继承项
    fireEvent.click(trigger);
    const menu = await screen.findByRole('listbox');
    expect(menu).toBeTruthy();
    expect(menu.textContent).not.toContain('跟随应用默认');
    // 顶部即模型枚举（p1 唯一 enabled provider）
    expect(screen.getByRole('option', { name: /MiniMax \/ glm-5.2/ })).toBeTruthy();
  });

  it('配 defaultModel → trigger 显 `provider / model`（formatModelDisplay 口径）', () => {
    __setProvidersCacheForTest([{ id: 'p1', label: 'MiniMax', models: [{ modelId: 'glm-5.2', label: 'glm-5.2' }] }]);
    renderDetail(makeDetail({ providerId: 'p1', modelId: 'glm-5.2' }));
    expect(screen.getByRole('button', { name: 'MiniMax / glm-5.2' })).toBeTruthy();
  });

  it('在 picker 选具体模型 → patchClassroom(classroomId, { defaultModel: sel })（PATCH 语义保留）', async () => {
    __setProvidersCacheForTest([{ id: 'p1', label: 'MiniMax', models: [{ modelId: 'glm-5.2', label: 'glm-5.2' }] }]);
    vi.mocked(patchClassroom).mockResolvedValue({
      id: 'c1',
      name: '一班',
      headTeacherSessionId: 's-head',
    } as never);
    renderDetail(makeDetail(undefined));
    fireEvent.click(screen.getByRole('button', { name: '选择 model' }));
    await screen.findByRole('listbox');
    fireEvent.click(screen.getByRole('option', { name: /MiniMax \/ glm-5.2/ }));
    await waitFor(() => {
      expect(patchClassroom).toHaveBeenCalledWith('c1', {
        defaultModel: { providerId: 'p1', modelId: 'glm-5.2' },
      });
    });
  });
});
