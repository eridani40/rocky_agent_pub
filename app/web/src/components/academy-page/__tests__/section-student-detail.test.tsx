/**
 * @vitest-environment jsdom
 * section-student-detail 单测 —— v0.0.220 ver-hero「进入观察」按钮（过程版 createdFromTaskId 驱动）
 * 参考: specs/ui/components/academy-page/section-student-detail.md（verHero）
 *
 * v0.0.220 ver-hero 改造防回归：
 *   - 正式版：删「编辑版本」按钮（编辑走下方四元组卡，readOnly 由 openMdEditor 控），槽位留空。
 *   - 过程版：原 readonly badge → 「进入观察」按钮，click → onOpenTrainingObserve(createdFromTaskId)。
 *   - createdFromTaskId 缺失的过程版不显按钮（异常兜底）。
 *
 * 重 mock 掉版本树 + 四元组卡（本 case 不测它们），聚焦 ver-hero 按钮门。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// 绝对路径 mock（memory: test-vitest-mock-absolute-path）
const { versionTreePath, tupleCardsPath, academyApiPath } = vi.hoisted(() => ({
  versionTreePath: require('node:path').resolve(__dirname, '../component-version-tree'),
  tupleCardsPath: require('node:path').resolve(__dirname, '../component-tuple-cards'),
  academyApiPath: require('node:path').resolve(__dirname, '../../../lib/academy-api'),
}));

vi.mock(versionTreePath, () => ({
  ComponentVersionTree: () => <div data-testid="mock-version-tree" />,
}));
vi.mock(tupleCardsPath, () => ({
  ComponentTupleCards: () => <div data-testid="mock-tuple-cards" />,
}));
vi.mock(academyApiPath, async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/academy-api')>();
  return { ...actual, patchVersion: vi.fn().mockResolvedValue({}) };
});

import { SectionStudentDetail } from '../section-student-detail';
import type { StudentDetail, StudentVersionEntity } from '../../../lib/academy-api';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => cleanup());

/** 造版本（formal / process），createdFromTaskId 仅 process 带 */
function mkVersion(
  over: Partial<StudentVersionEntity> & Pick<StudentVersionEntity, 'id' | 'versionLabel' | 'type'>,
): StudentVersionEntity {
  return {
    classroomId: 'cls-1',
    studentId: 'stu-1',
    workspaceDir: '/tmp/ws',
    ...over,
  };
}

function mkDetail(versions: StudentVersionEntity[]): StudentDetail {
  return {
    student: { id: 'stu-1', classroomId: 'cls-1', name: '小明', currentFormalVersionId: 'vf-1' },
    versions,
    tasks: [],
  };
}

function renderSection(detail: StudentDetail, selectedVersionId = 'vf-1') {
  const handlers = {
    onSelectVersion: vi.fn(),
    onBack: vi.fn(),
    onOpenTrainingObserve: vi.fn(),
    onStartSession: vi.fn(),
    onDeriveToStudio: vi.fn(),
    onStartTraining: vi.fn(),
    onEditVersion: vi.fn(),
    onOpenSkillBrowser: vi.fn(),
    onOpenMemoryModal: vi.fn(),
    onRefreshContent: vi.fn(),
  };
  render(
    <SectionStudentDetail
      classroomId="cls-1"
      studentId="stu-1"
      detail={detail}
      versionContent={null}
      selectedVersionId={selectedVersionId}
      {...handlers}
    />,
  );
  return handlers;
}

describe('SectionStudentDetail — ver-hero「进入观察」（v0.0.220）', () => {
  it('过程版（有 createdFromTaskId）→ 显「进入观察」按钮 → click 调 onOpenTrainingObserve(createdFromTaskId)', () => {
    const detail = mkDetail([
      mkVersion({ id: 'vf-1', versionLabel: '1.0', type: 'formal' }),
      mkVersion({ id: 'vp-1', versionLabel: '1.1', type: 'process', createdFromTaskId: 'task-xyz' }),
    ]);
    const handlers = renderSection(detail, 'vp-1');
    const btn = screen.getByRole('button', { name: /进入观察/ });
    fireEvent.click(btn);
    expect(handlers.onOpenTrainingObserve).toHaveBeenCalledWith('task-xyz');
  });

  it('正式版 → 无「编辑版本」按钮、无「进入观察」按钮（槽位留空）', () => {
    const detail = mkDetail([mkVersion({ id: 'vf-1', versionLabel: '1.0', type: 'formal' })]);
    renderSection(detail, 'vf-1');
    expect(screen.queryByRole('button', { name: /进入观察/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /编辑版本/ })).toBeNull();
  });

  it('过程版无 createdFromTaskId → 无「进入观察」按钮（异常兜底）', () => {
    const detail = mkDetail([
      mkVersion({ id: 'vf-1', versionLabel: '1.0', type: 'formal' }),
      mkVersion({ id: 'vp-1', versionLabel: '1.1', type: 'process' }),
    ]);
    renderSection(detail, 'vp-1');
    expect(screen.queryByRole('button', { name: /进入观察/ })).toBeNull();
  });
});

describe('SectionStudentDetail — 学生详情交互', () => {
  it('onStartTraining 不预锁 currentFormal（点击直接调，无参）', () => {
    const detail = mkDetail([mkVersion({ id: 'vf-1', versionLabel: '1.0', type: 'formal' })]);
    const handlers = renderSection(detail);
    fireEvent.click(screen.getByText('＋ 发起训练'));
    expect(handlers.onStartTraining).toHaveBeenCalledWith();
  });
});
