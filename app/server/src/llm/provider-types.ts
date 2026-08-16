/**
 * LLM Provider / Model / Protocol 的数据与字面量类型
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md §2
 *       specs/tech/agent/providers_and_models/[P0]llm_model_interface.md §2
 *       specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2
 *
 * 本文件只含「类型定义」，无运行时逻辑。
 * - LlmProviderConfig = app_config providers 组一条实例的 data 形状（per-instance 数据）
 * - LlmModelConfig = 该实例 models[] 中一条 record（per-instance 数据）
 * - ProviderName / ProtocolName 字面量 union（占位成员见各自注释）
 */

/**
 * provider 标识哪家接入方（按鉴权协议族）= 指向哪个 llm_provider ext impl。
 * v0.0.350 起 +4 native coding plan 类型（决策①，挂 llm_anthropic plugin 同 anthropic 协议域）。
 */
export type ProviderName =
  | 'anthropic_compatible' // Anthropic 直连及兼容端点
  | 'openai_compatible' // OpenAI / OpenRouter / Together / Ollama 等 Bearer 系
  | 'glm' // 智谱 GLM（未实现，仅占位）
  // ---- v0.0.350 四渠道 coding plan native（均 anthropic 协议 + 各自额度查询能力）----
  | 'kimi_coding_plan' // Kimi Coding Plan（额度型：5h+周桶，Bearer 查询）
  | 'glm_coding_plan' // 智谱 GLM Coding Plan（额度型，查询端点裸 key 实测特例）
  | 'minimax_coding_plan' // MiniMax Coding Plan（额度型：5h+周桶 status 门控）
  | 'deepseek_api'; // DeepSeek 按量付费（余额型：balance_infos + is_available）

/** protocol 标识请求翻译契约 = 指向哪个 llm_protocol ext impl */
export type ProtocolName =
  | 'anthropic_messages' // 唯一实现
  | 'openai_chat_completions' // 占位
  | 'openai_responses' // 占位
  | 'gemini_generateContent'; // 占位

/**
 * quota 作用域：per-key 可独立轮换；account-wide 不轮换（hermes 教训，
 * 参考 [P0]llm_request_config.md §4 + [P0]provider_health_registry.md §4）。
 */
export type QuotaScope = 'per_key' | 'account_wide';

/**
 * 多 key credentials 中的一条（[P0]llm_provider_interface.md §3.3）。
 * - keyRef: 引用名（"default"/"backup"/...），fallback_chain 通过它引用
 * - keyValue: 实际 key（或 "${ENV_VAR}" 形式的 env 引用）
 * - quotaScope: per-key 可轮换；account-wide RATE_LIMITED 直接 fallback 换 provider
 * - weight: 选择权重（默认 1，per-key 池内按权重选）
 */
export interface CredentialKey {
  keyRef: string;
  keyValue: string;
  quotaScope: QuotaScope;
  weight?: number;
}

/**
 * credentials union（[P0]llm_provider_interface.md §3.3）。
 *
 * 向后兼容：单 key `{ key: "sk-..." }` 等价于
 * `{ keys: [{ keyRef: "default", keyValue: "sk-...", quotaScope: "per_key" }] }`。
 * resolveCredentials helper（见 credentials.ts）做统一化。
 */
export type CredentialConfig =
  | { key: string } // 单 key（向后兼容形态）
  | { keys: CredentialKey[] }; // 多 key

/**
 * provider 数据（per-instance）= app_config providers 组一条实例的 data 形状。
 * 不是独立持久化 record——其承载者/落盘机制见 config/[P0]app_config.md §3.2。
 */
export interface LlmProviderConfig {
  /** 实例 id（= app_config providers 组 record key） */
  id: string;
  /** 标识哪家接入方（按鉴权协议族）= 指向哪个 llm_provider ext impl */
  name: ProviderName;
  /**
   * 1 provider : 1 protocol 锁定，必填（protocolId 单一事实源在此）。
   * factory 按 this 字段查 PluginManager.getExtensionImpls(llm_protocol) 命中 implId 动态实例化。
   * 参考: specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md §3.4
   */
  protocolId: ProtocolName;
  /** e.g. "https://api.anthropic.com" */
  baseUrl: string;
  /**
   * 凭证。单 key 或多 key union（向后兼容，见 CredentialConfig）。
   * 旧 provider 仍是 `{ key: string }`；新 provider 可配多 key 带 quotaScope。
   */
  credentials: CredentialConfig;
  /** 该实例来自哪个 plugin（builtin.<id> 或外部 plugin id） */
  pluginId: string;
  /** 该实例是否启用（两级 enabled 门之一） */
  enabled: boolean;
  /** 该实例下的 modelConfig 列表（每条 = 一个 LlmModelConfig） */
  models: LlmModelConfig[];
}

/** 模态：输入/输出两侧独立声明 */
export type Modality = 'text' | 'image' | 'audio' | 'video';

/** 币种（client computeCost 按此产出原币种 cost） */
export type Currency = 'USD' | 'CNY';

/** 参数取值约束（默认值/范围，字段名归 protocol） */
export interface ParamConstraints {
  temperature?: { default: number; min: number; max: number };
  topP?: { default: number; min: number; max: number };
}

/** 定价（per-instance 数据，是否支持 caching 由 cacheRead/Write 字段隐含） */
export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  currency: Currency;
}

/**
 * 模型长度处理能力位（length 处理决策依据）。
 * 参考: [P0]length_handling.md §5 + [P0]llm_model_interface.md §3.5
 *
 * ModelCapability 权威源在此，length_types.ts re-export 自此。
 */
export interface ModelCapability {
  /** 单次最大输出（token）—— 与顶层 LlmModelConfig.maxOutputTokens 同值（alias，迁移期双路径可读） */
  maxOutputTokens: number;
  /** 是否支持 prefill 续写（partial assistant turn 续接）—— Anthropic Messages API 支持，OpenAI 不支持 */
  supportsPrefill: boolean;
  /** 是否支持 extended thinking（reasoning）—— 影响是否产 thinking_delta */
  supportsThinking: boolean;
}

/**
 * modelConfig = app_config 数据（providers 组某条实例 models[] 的一条 record）。
 * 不是代码固有属性——由 app_config 配置/持久化。
 */
export interface LlmModelConfig {
  /** wire 模型标识："claude-sonnet-4-6" */
  modelId: string;
  inputModalities: Modality[];
  outputModalities: Modality[];
  /** 上下文窗口（token） */
  contextWindow: number;
  /**
   * 单次最大输出（token）。
   * 同时是 capabilities.maxOutputTokens 的 alias（向后兼容）：
   *   旧 modelConfig 不配 capabilities 时，length 处理读此字段作 maxOutputTokens；
   *   新 modelConfig 配 capabilities 后，二者应保持同值。
   */
  maxOutputTokens: number;
  /**
   * length 处理能力位（供 LlmCaller buildRequest 决策）。
   * 旧 record 可能缺此字段 → 消费方应用 resolveModelCapabilities 兜底
   * （默认 supportsPrefill=false / supportsThinking=false）。
   */
  capabilities?: ModelCapability;
  paramConstraints: ParamConstraints;
  pricing: Pricing;
  /** → app_config providers 组某条 provider 实例（LlmProviderConfig.id） */
  providerId: string;
  // protocolId 属 provider 级（LlmProviderConfig.protocolId），model config 不含
  // per-model default 字段已于 v0.0.143 删除
}

/** LlmClient 构造期可选注入的 tokenizer 契约（来源 context/usage 模块，本文只声明） */
export interface Tokenizer {
  count(text: string): number;
}

// ---- v0.0.350 额度/余额查询统一形状（决策⑧；四渠道解析器唯一输出契约）----
// 参考: specs/tech/version_logs/v0.0.350/change_plan.md 决策⑧ + specs/research/v0.0.350-live-verify.md

/** 额度窗口口径：5 小时滚动 / 周限额（cc-switch 同口径两桶） */
export type QuotaWindowKind = 'five_hour' | 'weekly';

/** 单个额度桶（已用百分比口径；重置时间 ISO 本地化由前端做） */
export interface QuotaTier {
  window: QuotaWindowKind;
  /** 已用百分比（0-100；kimi 由 limit/used 换算、minimax 由 100-remaining 反转、glm 直读） */
  usedPercent: number;
  /** 重置时间 ISO 字符串（缺失 = 渠道未提供，前端显示「--」） */
  resetsAt?: string;
}

/** 额度查询错误（单渠道隔离语义，不炸整体；kind 供前端文案分类） */
export interface QuotaError {
  /** auth=凭证失效(401/403)；business=业务错误(透原始文案)；network=网络失败；timeout=15s 超时 */
  kind: 'auth' | 'business' | 'network' | 'timeout';
  message: string;
}

/**
 * 额度/余额快照（统一形状；fetchedAt 由聚合端点填充）。
 * - kind='quota'（额度型）：tiers + membership；kind='balance'（余额型）：balance + isAvailable。
 * - error 态：仅 providerId/providerLabel/implId/error/fetchedAt 有值（LastGood 由前端持有）。
 */
export interface QuotaSnapshot {
  providerId: string;
  providerLabel: string;
  implId: ProviderName;
  kind: 'quota' | 'balance';
  tiers?: QuotaTier[];
  /** 套餐/会员档位（kimi membership.level / glm data.level） */
  membership?: string;
  balance?: {
    currency: string;
    /** 总额（数值化后的数字，前端格式化两位小数） */
    total: number;
    granted?: number;
    toppedUp?: number;
  };
  /** deepseek is_available（余额是否可用） */
  isAvailable?: boolean;
  error?: QuotaError;
  /** 快照拉取时刻（ms epoch；聚合端点统一 Date.now()） */
  fetchedAt: number;
}
