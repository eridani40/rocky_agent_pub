/**
 * training-engine/helpers — TrainingEngine 用的辅助函数
 * 参考: specs/tech/academy/[P0]training_engine.md §3（revise 流程）
 *
 * 拆分原因：training-engine.ts 主文件若含所有 helper 会超 300 行限制。
 * 这里集中：
 *   - stripEnvelope：CrudStore put 不允许 record 自带信封字段
 *   - extractVersionModel：version.json.model 子集提取
 *   - extractGraderConfig：GraderRecord → GraderConfig 隔离类型
 *   - joinSampleWithCases：sample 结果 join dataset item
 */
import type { GraderConfig } from './grade';
import type { SampleResult } from './sample';

/** CrudStore put 不允许 record 自带 createdAt/updatedAt/version；strip 掉 */
export function stripEnvelope<T extends { createdAt?: unknown; updatedAt?: unknown; version?: unknown }>(
  rec: T,
): Omit<T, 'createdAt' | 'updatedAt' | 'version'> {
  const { createdAt: _c, updatedAt: _u, version: _v, ...rest } = rec;
  return rest;
}

/** academy 版本模型快照 */
export interface VersionModel {
  providerId?: string;
  modelId: string;
}

/** version.json.model 子集提取（兼容 unknown） */
export function extractVersionModel(model: unknown): VersionModel {
  if (typeof model === 'object' && model !== null && 'modelId' in model) {
    const m = model as { modelId: string; providerId?: string };
    return { modelId: m.modelId, providerId: m.providerId };
  }
  return { modelId: 'unknown' };
}

/** GraderRecord → GraderConfig 提取（隔离 store 类型） */
export function extractGraderConfig(grader: {
  type: 'llm-judge' | 'em';
  promptTemplate?: string;
  providerId?: string;
  modelId?: string;
  threshold?: number;
  matchRule?: { caseInsensitive?: boolean; trim?: boolean };
}): GraderConfig {
  return {
    type: grader.type,
    promptTemplate: grader.promptTemplate,
    providerId: grader.providerId,
    modelId: grader.modelId,
    threshold: grader.threshold,
    matchRule: grader.matchRule,
  };
}

/** sample 结果 join dataset item（含 gradingCriteria / expectedAnswer） */
export function joinSampleWithCases(
  samples: SampleResult[],
  items: Array<{
    id: string;
    question: string;
    gradingCriteria?: string;
    expectedAnswer?: string;
  }>,
): Array<{
  caseId: string;
  question: string;
  gradingCriteria?: string;
  expectedAnswer?: string;
  studentOutput: string;
  rateLimited: boolean;
}> {
  const map = new Map(items.map((i) => [i.id, i]));
  return samples.map((s) => {
    const item = map.get(s.caseId);
    return {
      caseId: s.caseId,
      question: item?.question ?? '',
      gradingCriteria: item?.gradingCriteria,
      expectedAnswer: item?.expectedAnswer,
      studentOutput: s.studentOutput,
      rateLimited: s.rateLimited,
    };
  });
}
