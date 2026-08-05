/**
 * use-derive-options —— squad 派生「从教室派生」picker 的数据装配（studio member-create 消费）
 * 参考: specs/ui/components/academy-page/component-derive-academy-picker.md（Props 数据形）
 *       specs/tech/academy/[P1]squad_derive.md（仅 formal+active 版本可派生）
 *
 * 输出：classrooms（含 studentCount）+ 当前选中教室的 students（最新正式版 label/id；
 *   仅 0.0 初始版的学生 latestVersionId=undefined → picker 禁用「仅初始版 · 内容为空」）。
 * 数据链：listClassrooms → getClassroomDetail（学生列表）→ 逐学生 getStudentDetail（版本）——
 *   N 小（教室/学生 << 数十），N+1 可接受。
 */
import { useEffect, useState } from 'react';
import {
  getClassroomDetail,
  getStudentDetail,
  listClassrooms,
} from '../../lib/academy-api';
import type { DeriveClassroomOption, DeriveStudentOption } from './component-derive-academy-picker';

/** hook 返回形 */
export interface DeriveOptionsResult {
  classrooms: DeriveClassroomOption[];
  students: DeriveStudentOption[];
  loading: boolean;
}

/** logo 底色轮换（与 sidebar 同款） */
const LOGO_BGS = ['var(--hue-violet-bg)', 'var(--info-bg)', 'var(--hue-pink-bg)', 'var(--success-bg)', 'var(--warning-bg)'];
const STUDENT_GRADIENTS = [
  'linear-gradient(135deg,#ec4899,#f97316)',
  'linear-gradient(135deg,#3b82f6,#8b5cf6)',
  'linear-gradient(135deg,#14b8a6,#22c55e)',
  'linear-gradient(135deg,#f59e0b,#f43f5e)',
];

/**
 * 派生选项装配。
 * @param selectedClassroomId 当前选中教室（students 列随其变化）
 */
export function useDeriveOptions(selectedClassroomId?: string): DeriveOptionsResult {
  const [classrooms, setClassrooms] = useState<DeriveClassroomOption[]>([]);
  const [students, setStudents] = useState<DeriveStudentOption[]>([]);
  const [loading, setLoading] = useState(true);

  // 教室列表（mount 一次）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listClassrooms();
        const withCounts = await Promise.all(
          list.map(async (c, i) => {
            let studentCount = 0;
            try {
              const d = await getClassroomDetail(c.id);
              studentCount = d.students.length;
            } catch { /* 计数失败显 0 */ }
            return {
              id: c.id,
              name: c.name,
              logo: c.logo,
              logoBg: LOGO_BGS[i % LOGO_BGS.length],
              studentCount,
            };
          }),
        );
        if (!cancelled) setClassrooms(withCounts);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 选中教室的学生·版本列
  useEffect(() => {
    if (!selectedClassroomId) {
      setStudents([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const d = await getClassroomDetail(selectedClassroomId);
        const opts = await Promise.all(
          d.students.map(async (s, i): Promise<DeriveStudentOption> => {
            try {
              const sd = await getStudentDetail(selectedClassroomId, s.id);
              // 最新正式版（排除 0.0 初始空版；按 label 数值取最大）
              const formal = sd.versions
                .filter((v) => v.type === 'formal' && v.versionLabel !== '0.0')
                .sort((a, b) => b.versionLabel.localeCompare(a.versionLabel, undefined, { numeric: true }));
              const latest = formal[0];
              return {
                id: s.id,
                name: s.name,
                avatarGradient: latest ? STUDENT_GRADIENTS[i % STUDENT_GRADIENTS.length] : undefined,
                latestVersionId: latest?.id,
                latestVersionLabel: latest ? `v${latest.versionLabel}` : undefined,
                recommended: i === 0 && latest !== undefined,
              };
            } catch {
              return { id: s.id, name: s.name };
            }
          }),
        );
        if (!cancelled) setStudents(opts);
      } catch {
        if (!cancelled) setStudents([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedClassroomId]);

  return { classrooms, students, loading };
}
