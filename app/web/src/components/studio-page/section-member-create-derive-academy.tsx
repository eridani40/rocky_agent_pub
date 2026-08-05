/**
 * section-member-create-derive-academy —— 成员创建「从教室派生」面板（studio 侧薄壳）
 * 参考: specs/ui/overall/12-academy.md §10（派生 = 复用 member-create 二级 select，非独立大页面）
 *       specs/tech/academy/[P1]squad_derive.md §4（UI 契约）
 *       demo 07-squad-derive.html
 *
 * 边界：picker 本体 + 数据 hook 在 academy-page（component-derive-academy-picker /
 *   use-derive-options / [v0.0.233] use-derive-academy-preview——跨目录复用契约：academy 出组件，
 *   studio 消费）；本文件只做选中态管理 + 提交上抛（name = 学生名自动带上，后端 derive_academy
 *   name 必填）。
 * [v0.0.233] 合并 selection + preview 状态：picker 上抛 preview status/resolution → 本节合并进
 *   DeriveAcademySelection 上抛父级（resolution + previewReady）；父级据此 gate 提交按钮。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ComponentDeriveAcademyPicker,
} from '../academy-page/component-derive-academy-picker';
import { useDeriveOptions } from '../academy-page/use-derive-options';
import type { DeriveResolution } from './squad-types';

/** 派生源（提交上抛；academySource 三元组 + 成员名 + [v0.0.233] 裁决结果 + preview 就绪标志） */
export interface DeriveAcademySelection {
  academySource: { classroomId: string; studentId: string; versionId: string };
  name: string;
  /** [v0.0.233] 同名裁决（undefined = 无同名项或后端默认全 skip 同名） */
  resolution?: DeriveResolution;
  /** [v0.0.233] preview 是否就绪（false = loading/error → 父级提交按钮 disabled） */
  previewReady: boolean;
}

interface Props {
  /** [v0.0.233] 目标 squad（picker preview endpoint path 参数） */
  squadId: string;
  /** 初始选中（academy「派生到团队」入口预填；可选） */
  initialClassroomId?: string;
  initialStudentId?: string;
  /** 选中变化（父级持最新选择供提交） */
  onSelectionChange: (sel: DeriveAcademySelection | null) => void;
}

/** 「从教室派生」面板（picker 内嵌 + 数据装配；确认/取消按钮走宿主统一操作条） */
export function SectionMemberCreateDeriveAcademy({ squadId, initialClassroomId, initialStudentId, onSelectionChange }: Props) {
  const [classroomId, setClassroomId] = useState<string | undefined>(initialClassroomId);
  const [studentId, setStudentId] = useState<string | undefined>(initialStudentId);
  const { classrooms, students } = useDeriveOptions(classroomId);
  // [v0.0.233] preview 状态（picker 上抛）：resolution + ready
  const [resolution, setResolution] = useState<DeriveResolution | undefined>(undefined);
  const [previewReady, setPreviewReady] = useState(false);

  // 稳定回调（避免 inline arrow 每次 render 新引用触发 picker 的 effect dep 抖动）
  const handlePreviewState = useCallback((state: { status: 'idle' | 'loading' | 'ready' | 'error'; resolution?: DeriveResolution }) => {
    setResolution(state.resolution);
    setPreviewReady(state.status === 'ready');
  }, []);

  // 教室列表到位后默认选第一个（无初始选中时）
  useEffect(() => {
    if (!classroomId && classrooms.length > 0) setClassroomId(classrooms[0]!.id);
  }, [classrooms, classroomId]);

  // 选中变化上抛（name = 学生名；versionId = 最新正式版）；preview 状态合并进 selection
  useEffect(() => {
    const stu = students.find((s) => s.id === studentId);
    if (classroomId && stu?.latestVersionId) {
      onSelectionChange({
        academySource: { classroomId, studentId: stu.id, versionId: stu.latestVersionId },
        name: stu.name,
        resolution,
        previewReady,
      });
    } else {
      onSelectionChange(null);
    }
  }, [classroomId, studentId, students, resolution, previewReady, onSelectionChange]);

  return (
    <ComponentDeriveAcademyPicker
      embedded
      squadId={squadId}
      classrooms={classrooms}
      students={students}
      selectedClassroomId={classroomId}
      selectedStudentId={studentId}
      onPickClassroom={(id) => {
        setClassroomId(id);
        setStudentId(undefined);
      }}
      onPickStudent={setStudentId}
      onPreviewStateChange={handlePreviewState}
      onCancel={() => {}}
      onConfirm={() => {}}
    />
  );
}

export default SectionMemberCreateDeriveAcademy;
