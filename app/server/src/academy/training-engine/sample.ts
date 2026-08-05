/**
 * training-engine/sample — 批量 sample（直调 LLM + pLimit 并发）
 * 参考: specs/tech/academy/[P0]training_engine.md §5（评估 fan-out）
 *       specs/tech/academy/[P0]evaluation.md §4（fan-out 直调实现，pLimit(5)）
 *
 * 设计：
 *   - 每个案例独立调 LlmPort.invoke（"每 case 独立调"硬约束，调研 §4.1）
 *   - 并发由 createLimit(5) 控制（自实现 p-limit，无新依赖）
 *   - 学生模型 = version.json.model（task.temporaryBaselineVersionId 指向的版本）
 *   - rate_limited 失败不抛 — 返 studentOutput='' + rateLimited=true（grade 阶段兜底）
 *   - 其他错误抛 — 由调用方（assessVersion → evaluate/revise）catch
 */
import type { AcademyLlmPort } from './llm-port';
import { createLimit } from './p-limit';
import { isReservedModelId } from '../../services/model-validation';
import type { ResolvedVersionContent } from '../academy-version-dir';

/** sample 单 case 输入（dataset item 子集） */
export interface SampleCaseInput {
  /** case id（dataset 内唯一） */
  id: string;
  /** 问题正文 */
  question: string;
}

/** sample 单 case 输出 */
export interface SampleResult {
  caseId: string;
  /** 学生答题输出（成功时为 LLM 文本；限流时为空串） */
  studentOutput: string;
  /** 是否限流兜底（让 grade 阶段标 score=-1） */
  rateLimited: boolean;
}

/** sample 批量入参（task + dataset cases + 版本内容） */
export interface SampleBatchInput {
  /** academy 引擎 LLM 端口 */
  llmPort: AcademyLlmPort;
  /** 并发上限（默认 5） */
  concurrency?: number;
  /** 学生 baseline 版本内容（已解析的 AGENTS.md + version.json） */
  versionContent: ResolvedVersionContent;
  /** dataset cases 列表 */
  cases: SampleCaseInput[];
}

/**
 * 批量 sample（pLimit 并发；每 case 独立调用）。
 * 顺序保留（输出与输入 cases 同序），方便后续 grade join。
 */
export async function sampleBatch(input: SampleBatchInput): Promise<SampleResult[]> {
  const limit = createLimit(input.concurrency ?? 5);
  return Promise.all(
    input.cases.map((c) => limit(() => sampleOne(input.llmPort, input.versionContent, c))),
  );
}

/**
 * 单 case sample：直调 LlmPort.invoke，按 system=AGENTS.md / user=question 组装请求。
 *
 * 失败处理：
 *   - ok=false + errorKind='rate_limited' → 返 studentOutput='' + rateLimited=true（不抛）
 *   - 其他错误 → 抛（由调用方 catch）
 */
export async function sampleOne(
  llmPort: AcademyLlmPort,
  versionContent: ResolvedVersionContent,
  caseItem: SampleCaseInput,
): Promise<SampleResult> {
  const model = versionContent.versionJson?.model;
  const modelId = model?.modelId;
  // 版本自含 model 是五元组契约（data_model §3.1）：不自动 fallback app 默认模型——
  // fallback 会让版本行为依赖运行时 app 配置，训练评估不可复现。
  // 缺 providerId / 缺 modelId / 保留字（'default' 等）→ actionable 报错（指引进版本编辑修复）。
  if (!model?.providerId || !modelId || isReservedModelId(modelId)) {
    throw new Error(
      `sampleOne: case ${caseItem.id} 的学生版本 version.json 缺有效 model` +
      `（providerId=${model?.providerId ?? '缺失'}, modelId=${modelId ?? '缺失'}）— ` +
      `版本须自含 providerId+modelId（五元组契约），请在版本编辑里设置 model 后重试`,
    );
  }
  const providerId = model.providerId;

  const result = await llmPort.invoke({
    providerId,
    modelId,
    systemPrompt: versionContent.agentsMd,
    userMessage: caseItem.question,
  });

  if (result.ok) {
    return {
      caseId: caseItem.id,
      studentOutput: result.text ?? '',
      rateLimited: false,
    };
  }

  if (result.errorKind === 'rate_limited') {
    return { caseId: caseItem.id, studentOutput: '', rateLimited: true };
  }
  // 其他错误兜底：抛由调用方决策（区别于 rate_limited 的"该 case 兜底，其他继续"）
  throw new Error(
    `sampleOne: case ${caseItem.id} LLM 调用失败 — ${result.errorMessage ?? 'unknown'}`,
  );
}
