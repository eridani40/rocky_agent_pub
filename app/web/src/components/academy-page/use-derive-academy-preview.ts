/**
 * use-derive-academy-preview —— derive_academy 派生前「继承预检」hook（v0.0.233）
 * 参考: specs/api/overall/11a-squad-endpoints.md §2.5（preview endpoint + PreviewResult schema）
 *       specs/ui/components/academy-page/component-derive-academy-picker.md（消费契约）
 *
 * 选定 classroom/student/version 全三字段后调 POST /squad/:id/member/derive-academy/preview
 *   拉清单（agentsMd / skills / memory + 同名标记）；任一字段缺 → idle 不发请求（避免无谓请求）。
 * 三态：status = 'idle' | 'loading' | 'ready' | 'error'；source 变化时取消旧请求（cancelled flag，
 *   防止竞态把旧结果写入新 source）。失败不抛（status='error' 给组件展示兜底文案）。
 */
import { useEffect, useState } from 'react';
import { previewDeriveAcademy, type PreviewResult } from '../../lib/squad-api';

/** preview 源（与 hire body academySource 同结构；undefined/字段缺 → idle） */
export interface DeriveAcademySource {
  classroomId: string;
  studentId: string;
  versionId: string;
}

/** preview 生命周期状态 */
export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseDeriveAcademyPreviewResult {
  status: PreviewStatus;
  data?: PreviewResult;
  /** error 兜底文案（status='error' 时有值） */
  error?: string;
}

/** 判定 source 三字段齐全 */
function sourceComplete(s?: DeriveAcademySource): s is DeriveAcademySource {
  return !!s && !!s.classroomId && !!s.studentId && !!s.versionId;
}

/**
 * derive_academy 继承预检。
 * @param squadId 目标 squad（preview endpoint path 参数）
 * @param source  选定源（三字段齐全才发请求；undefined/缺字段 → idle）
 */
export function useDeriveAcademyPreview(
  squadId: string,
  source?: DeriveAcademySource,
): UseDeriveAcademyPreviewResult {
  const [status, setStatus] = useState<PreviewStatus>('idle');
  const [data, setData] = useState<PreviewResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const complete = sourceComplete(source);

  useEffect(() => {
    // 三字段任一缺 → 回 idle（消费方未选定时不发请求）
    if (!complete || !source) {
      setStatus('idle');
      setData(undefined);
      setError(undefined);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setData(undefined);
    setError(undefined);
    void (async () => {
      try {
        const r = await previewDeriveAcademy(squadId, source);
        if (cancelled) return;
        setData(r);
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '预检失败');
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [squadId, complete, source?.classroomId, source?.studentId, source?.versionId]);

  return { status, data, error };
}

export default useDeriveAcademyPreview;
