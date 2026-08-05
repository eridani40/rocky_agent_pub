/**
 * training-engine/assess — 版本评估共享核心（sample + grade + avgScore 计算）
 * 参考: specs/tech/academy/[P0]training_engine.md §3（revise 流程 sample+grade 段）+ §3.1（evaluate）
 *       specs/tech/academy/[P0]evaluation.md §4（fan-out 直调实现）
 *
 * 拆分原因：
 *   evaluateVersion（纯查询）与 reviseCandidate（推进一轮）都需要 sample+grade 指定版本。
 *   抽出 assessVersion 纯评估函数（不改 task/turn 状态），两边复用，避免逻辑重复。
 *
 * 不变量：
 *   - 不改 task/turn 状态、不落 turn record（纯评估）
 *   - dataset/grader 必填（simple/learning 无 dataset 走 revise 内的「直接采纳」分支，不进 assess）
 *   - rate_limited 不抛（sample/grade 子模块各自兜底 score=-1）
 */
import type { TrainingEngineDeps } from '../training-engine';
import type { AcademyStore } from '../academy-store';
import { resolveVersionContent } from '../academy-version-dir';
import { sampleBatch, type SampleResult } from './sample';
import { gradeBatch, type GradeResult } from './grade';
import {
  extractVersionModel,
  extractGraderConfig,
  joinSampleWithCases,
} from './helpers';

/** assessVersion 出参（evaluate + revise 共享的评估三件套） */
export interface AssessResult {
  samples: SampleResult[];
  grades: GradeResult[];
  /** 有效分数（score >= 0）均值；无有效分数 → 0 */
  avgScore: number;
}

/**
 * 对指定版本做 sample + grade（evaluate + revise 共享核心）。
 *
 * @param deps        引擎依赖（llmPort / pLimitConcurrency）
 * @param store       AcademyStore 实例
 * @param classroomId 教室 id
 * @param versionId   被评估的版本 id（candidate 或 base 均可）
 * @param datasetId   dataset id（必填）
 * @param graderId    grader id（必填）
 */
export async function assessVersion(
  deps: TrainingEngineDeps,
  store: AcademyStore,
  classroomId: string,
  versionId: string,
  datasetId: string,
  graderId: string,
): Promise<AssessResult> {
  const dataset = await store.getDataset(classroomId, datasetId);
  if (!dataset) throw new Error(`assessVersion: dataset ${datasetId} 不存在`);
  const grader = await store.getGrader(classroomId, graderId);
  if (!grader) throw new Error(`assessVersion: grader ${graderId} 不存在`);
  const version = await store.getVersion(classroomId, versionId);
  if (!version) throw new Error(`assessVersion: version ${versionId} 不存在`);
  const versionContent = await resolveVersionContent(version.workspaceDir);

  // dataset.items schema 层 json 透传（unknown）；这里按业务契约强转
  const items = dataset.items as Array<{
    id: string;
    question: string;
    gradingCriteria?: string;
    expectedAnswer?: string;
  }>;

  const samples = await sampleBatch({
    llmPort: deps.llmPort,
    concurrency: deps.pLimitConcurrency,
    versionContent,
    cases: items.map((c) => ({ id: c.id, question: c.question })),
  });

  const fallbackModel = extractVersionModel(versionContent.versionJson?.model);
  const grades = await gradeBatch({
    llmPort: deps.llmPort,
    concurrency: deps.pLimitConcurrency,
    grader: extractGraderConfig({
      ...grader,
      matchRule: grader.matchRule as { caseInsensitive?: boolean; trim?: boolean } | undefined,
    }),
    fallbackStudentModel: fallbackModel,
    cases: joinSampleWithCases(samples, items),
  });

  const validScores = grades.filter((g) => g.score >= 0).map((g) => g.score);
  const avgScore = validScores.length > 0
    ? validScores.reduce((s, n) => s + n, 0) / validScores.length
    : 0;

  return { samples, grades, avgScore };
}
