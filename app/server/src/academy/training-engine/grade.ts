/**
 * training-engine/grade — 批量 grade（直调 LLM 或 em 纯函数 + pLimit 并发）
 * 参考: specs/tech/academy/[P0]training_engine.md §5（评估 fan-out）
 *       specs/tech/academy/[P0]evaluation.md §2（grader 类型体系）+ §3（GradeResult 三要素）
 *
 * 设计：
 *   - type='em' 纯函数精确匹配（无 LLM）
 *   - type='llm-judge' 直调 LlmPort.invoke + JSON 解析 {score, reasoning}
 *   - reasoning 必填（spec §3 评估三要素）
 *   - score 0.0-1.0（用户视角分数）；分级 level：positive / neutral / negative
 *   - 分级阈值 evaluation.md §3.1：score>=t → positive；score∈[t-0.3,t) → neutral；<t-0.3 → negative
 *   - rate_limited：score=-1 + level='neutral' + reasoning='rate_limited'（不阻塞其他 case）
 */
import type { AcademyLlmPort } from './llm-port';
import { createLimit } from './p-limit';

/** grader 配置（从 GraderRecord 提取的最小子集） */
export interface GraderConfig {
  type: 'llm-judge' | 'em';
  /** type='llm-judge'：promptTemplate（含 {question}/{student_output}/{criteria}） */
  promptTemplate?: string;
  /** type='llm-judge'：可选 judge 模型；缺省 = 学生所用模型 */
  providerId?: string;
  modelId?: string;
  /** 阈值（默认 0.5） */
  threshold?: number;
  /** type='em'：匹配规则 */
  matchRule?: { caseInsensitive?: boolean; trim?: boolean };
}

/** 单 case grade 的完整输入（dataset item + sample 输出 + 学生模型兜底） */
export interface GradeCaseInput {
  caseId: string;
  question: string;
  gradingCriteria?: string;
  expectedAnswer?: string;
  studentOutput: string;
  /** 限流标志（sample 阶段已标） */
  rateLimited: boolean;
}

/** grade 结果三要素（spec §3） */
export interface GradeResult {
  caseId: string;
  /** 0.0-1.0；rate_limited 兜底为 -1 */
  score: number;
  level: 'positive' | 'negative' | 'neutral';
  /** 必填：评分理由（含 rate_limited 标记） */
  reasoning: string;
}

/** grade 单 case 入参 */
export interface GradeOneInput {
  llmPort: AcademyLlmPort;
  grader: GraderConfig;
  /** 学生模型兜底（grader.providerId/modelId 缺省时用） */
  fallbackStudentModel: { providerId?: string; modelId: string };
  caseInput: GradeCaseInput;
}

/** grade 批量入参 */
export interface GradeBatchInput {
  llmPort: AcademyLlmPort;
  /** 并发上限（默认 5） */
  concurrency?: number;
  grader: GraderConfig;
  fallbackStudentModel: { providerId?: string; modelId: string };
  cases: GradeCaseInput[];
}

/**
 * 批量 grade（pLimit 并发；每 case 独立调用 / 独立评分）。
 * 顺序与输入同序，方便 join。
 */
export async function gradeBatch(input: GradeBatchInput): Promise<GradeResult[]> {
  const limit = createLimit(input.concurrency ?? 5);
  return Promise.all(
    input.cases.map((c) =>
      limit(() =>
        gradeOne({
          llmPort: input.llmPort,
          grader: input.grader,
          fallbackStudentModel: input.fallbackStudentModel,
          caseInput: c,
        }),
      ),
    ),
  );
}

/**
 * 单 case grade。
 * - rate_limited=true → 直接返 -1 / neutral / 'rate_limited'
 * - em：纯函数精确匹配（trim/caseInsensitive）
 * - llm-judge：插值 prompt → 直调 LLM → 解析 JSON
 */
export async function gradeOne(input: GradeOneInput): Promise<GradeResult> {
  const { grader, caseInput } = input;
  // rate_limited 兜底：保留 caseId 占位，让 gradeResults 长度与 sampleResults 对齐
  if (caseInput.rateLimited) {
    return {
      caseId: caseInput.caseId,
      score: -1,
      level: 'neutral',
      reasoning: 'rate_limited',
    };
  }

  if (grader.type === 'em') {
    return gradeEm(grader, caseInput);
  }
  if (grader.type === 'llm-judge') {
    return gradeLlmJudge(input);
  }
  throw new Error(`gradeOne: 不支持的 grader.type=${grader as unknown as string}`);
}

/** em 纯函数精确匹配（spec evaluation §2.1） */
function gradeEm(grader: GraderConfig, c: GradeCaseInput): GradeResult {
  const rule = grader.matchRule ?? {};
  const expected = c.expectedAnswer ?? '';
  let actual = c.studentOutput;
  if (rule.trim) actual = actual.trim();
  const matched = rule.caseInsensitive
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
  return {
    caseId: c.caseId,
    score: matched ? 1 : 0,
    level: matched ? 'positive' : 'negative',
    reasoning: `EM match: ${matched ? 'pass' : 'fail'}`,
  };
}

/** llm-judge 直调 LLM + JSON 解析（spec evaluation §2.4） */
async function gradeLlmJudge(input: GradeOneInput): Promise<GradeResult> {
  const { grader, caseInput, llmPort, fallbackStudentModel } = input;
  const template = grader.promptTemplate ?? '';
  const prompt = interpolate(template, {
    question: caseInput.question,
    student_output: caseInput.studentOutput,
    criteria: caseInput.gradingCriteria ?? '',
  });

  const providerId = grader.providerId ?? fallbackStudentModel.providerId;
  const modelId = grader.modelId ?? fallbackStudentModel.modelId;

  const result = await llmPort.invoke({
    providerId,
    modelId,
    systemPrompt: '',
    userMessage: prompt,
  });

  if (!result.ok) {
    if (result.errorKind === 'rate_limited') {
      return {
        caseId: caseInput.caseId,
        score: -1,
        level: 'neutral',
        reasoning: 'rate_limited',
      };
    }
    throw new Error(
      `gradeLlmJudge: case ${caseInput.caseId} LLM 调用失败 — ${result.errorMessage ?? 'unknown'}`,
    );
  }

  return parseLlmJudgeResult(result.text ?? '', caseInput.caseId, grader.threshold ?? 0.5);
}

/** 简单占位符插值（{key} → value），不做 HTML 转义 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

/**
 * 解析 llm-judge 返回的 JSON（{score, reasoning}）。
 *
 * 容错策略：
 *   - 先尝试整段 JSON.parse
 *   - 失败 → 提取首个 ```json``` 代码块 / 首个 `{...}` 子串
 *   - 仍失败 → 兜底 score=0 / reasoning='parse_failed: <原文前 100 字>'
 */
export function parseLlmJudgeResult(
  text: string,
  caseId: string,
  threshold: number,
): GradeResult {
  const parsed = tryParseJson(text);
  const score = typeof parsed?.score === 'number' ? clamp01(parsed.score) : 0;
  const reasoning =
    typeof parsed?.reasoning === 'string' && parsed.reasoning.length > 0
      ? parsed.reasoning
      : (text.length > 0 ? `parse_failed: ${text.slice(0, 100)}` : 'empty_llm_response');

  return {
    caseId,
    score,
    level: levelFromScore(score, threshold),
    reasoning,
  };
}

/** 0.0-1.0 钳位（防 LLM 返 -1 / 1.5） */
function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** score → level（spec evaluation §3.1） */
export function levelFromScore(
  score: number,
  threshold: number,
): 'positive' | 'negative' | 'neutral' {
  if (score >= threshold) return 'positive';
  if (score >= threshold - 0.3) return 'neutral';
  return 'negative';
}

/** 容错 JSON 解析：先整段 → 抽 ```json``` 块 → 抽 {...} */
function tryParseJson(text: string): { score?: unknown; reasoning?: unknown } | null {
  // 1. 整段 JSON.parse
  try {
    return JSON.parse(text);
  } catch {
    // 继续
  }
  // 2. ```json ... ``` 代码块
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // 继续
    }
  }
  // 3. 首个 {...} 子串
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      // 失败 → null
    }
  }
  return null;
}
