/**
 * @vitest-environment jsdom
 * section-classroom-list 单测 —— 新建教室表单默认模型必选（v0.0.230）
 * 参考: specs/ui/components/academy-page/section-classroom-list.md
 *       specs/tech/version_logs/v0.0.230/change_plan.md 第 5 行
 *
 * 覆盖（PRD §2.2 UC-230-8 + P-B）：
 * - 填 name 未选默认模型 → submit 不调 onCreateClassroom（必填错误「请选择默认模型」出现）
 * - 选具体模型后 → submit 调 onCreateClassroom(name, sel)
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { __setProvidersCacheForTest, __resetProvidersCacheForTest } from '../../../lib/providers';

import { SectionClassroomList } from '../section-classroom-list';

beforeAll(async () => {
  await initI18n('zh-CN');
});

/** 测试桩 providers（ModelPicker 用；经 __setProvidersCacheForTest 注入绕过真实 fetch） */
const PROVIDER_STUB = [{ id: 'p1', label: 'MiniMax', models: [{ modelId: 'glm-5.2', label: 'glm-5.2' }] }];

beforeEach(() => {
  cleanup();
  __resetProvidersCacheForTest();
  __setProvidersCacheForTest(PROVIDER_STUB);
});
afterEach(() => {
  cleanup();
  __resetProvidersCacheForTest();
});

function renderList(onCreate: (name: string, sel: { providerId: string; modelId: string }) => Promise<void>) {
  return render(
    <SectionClassroomList
      classrooms={[]}
      statsOf={() => ({ studentCount: 0, activeTaskCount: 0 })}
      selectedId={undefined}
      onSelect={() => {}}
      onCreated={() => {}}
      onCreateClassroom={onCreate}
      createOpen
      onCreateOpenChange={() => {}}
    />,
  );
}

describe('SectionClassroomList 新建教室默认模型必选（v0.0.230）', () => {
  it('填 name 未选默认模型 → submit 不调 onCreateClassroom（必填错误提示出现）', () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    renderList(onCreate);
    fireEvent.change(screen.getByPlaceholderText('教室名称'), { target: { value: '新班' } });
    fireEvent.keyDown(screen.getByPlaceholderText('教室名称'), { key: 'Enter' });
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText('请选择默认模型')).toBeTruthy();
  });

  it('选具体模型后 → submit 调 onCreateClassroom(name, sel)', () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    renderList(onCreate);
    fireEvent.change(screen.getByPlaceholderText('教室名称'), { target: { value: '新班' } });
    // 打开默认模型 picker → 选具体模型
    fireEvent.click(screen.getByRole('button', { name: '选择 model' }));
    fireEvent.click(screen.getByRole('option', { name: /MiniMax \/ glm-5.2/ }));
    fireEvent.keyDown(screen.getByPlaceholderText('教室名称'), { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith('新班', { providerId: 'p1', modelId: 'glm-5.2' });
  });
});
