/**
 * training-engine/llm-port — academy 引擎调用 LLM 的简化端口
 * 参考: specs/tech/academy/[P0]training_engine.md §5（sample/grade 直调 LLM）
 *       specs/tech/academy/[P0]evaluation.md §4（fan-out 直调实现）
 *
 * 设计背景（coder 决策）：
 *   现有 `LlmCaller.invoke(baseReq, ctx)` 签名耦合 InvokeContext（observability/controller/
 *   errorState/providers/clientFactory 等生产路径字段）。academy 引擎的 sample/grade 是
 *   "纯文本输入/输出"的快速调用，不需要 agent loop 全套 ctx；强绑定会让 UT 必须造大量 mock。
 *
 *   因此定义一个**窄端口 AcademyLlmPort**：`{providerId, modelId, systemPrompt, userMessage} →
 *   {text}`。引擎只依赖这个窄接口；具体把 LlmCaller 包装成此端口的工作由 bootstrap（E 节）
 *   注入 adapter 完成。**这是实现细节偏离，核心约束（直调 LLM + pLimit + 每案例独立）未变**。
 *
 *   偏离项：spec §2 TrainingEngineDeps 写 `llmCaller: LlmCaller`，实际实现 `llmPort: AcademyLlmPort`。
 *   汇报 orchestrator + doc-sync 阶段 5 修 spec 对齐。
 *
 *   RateLimitedError 信号：错误返回时不抛 — 让 port 把 429/529/503 等可恢复错误归一为
 *   `{ ok: false, errorKind: 'rate_limited' }`，引擎把该 case 标 score=-1（不阻塞其他 case）。
 *   其他错误抛出（由调用方 catch 决策）。
 */

/** 单次 LLM 调用入参（窄端口） */
export interface AcademyLlmInvokeInput {
  /** provider 配置 id（学生 version.json.model.providerId） */
  providerId?: string;
  /** 模型 id（学生 version.json.model.modelId） */
  modelId: string;
  /** system prompt（学生 AGENTS.md 全文） */
  systemPrompt: string;
  /** user 消息（case.question 或 grader 插值后的 prompt） */
  userMessage: string;
}

/** 单次 LLM 调用结果 */
export interface AcademyLlmInvokeResult {
  /** 是否成功（false = 限流/超时；errorKind 给原因） */
  ok: boolean;
  /** 成功时的纯文本输出（取 content[0].text） */
  text?: string;
  /** 失败原因分类：'rate_limited' / 'other'（rate_limited 由调用方兜底标 score=-1） */
  errorKind?: 'rate_limited' | 'other';
  /** 失败时的原始错误信息（UT/debug 用） */
  errorMessage?: string;
}

/**
 * AcademyLlmPort — academy 引擎调用 LLM 的窄端口。
 *
 * 实现方（bootstrap E 节注入）：
 *   - 生产实现：内部调 LlmCaller.invoke，把 InvokeResponse.message.content[0].text 提出来
 *     + 把 ClassifiedLlmError.category ∈ {RATE_LIMITED, PROVIDER_OVERLOADED, SERVER_ERROR}
 *     归一为 `{ ok: false, errorKind: 'rate_limited' }`
 *   - UT 实现：直接 mock 返回固定文本
 */
export interface AcademyLlmPort {
  invoke(input: AcademyLlmInvokeInput): Promise<AcademyLlmInvokeResult>;
}
