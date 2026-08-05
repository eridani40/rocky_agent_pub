/**
 * Message + ContentBlock 子集（v0.0.8 业务权威类型）
 * 参考: specs/tech/agent/message/[P0]agent_message_interface.md §1/§3/§4/§5
 *       specs/tech/version_logs/v0.0.8/change_log.md §3
 *       specs/tech/version_logs/v0.0.101/change_log.md §1（HITL：ToolResultBlock 三态 + tool_reply）
 *
 * 本文件是 agent 业务的 message 类型权威源：
 *   - ContentBlock 子集（v0.0.8 实现 5 类 + v0.0.101 加 tool_reply + v0.0.105 加 image 共 7 类）
 *   - Message 形态（含 sessionId/runId/sender 业务字段）
 *   - 信封字段（createdAt/updatedAt/version）由 CrudStore 注入，业务 put 时不传
 *
 * [v0.0.105] ImageBlock 补回（截图回灌 LLM 闭环，spec §4.2；computer use get_app_state 首个消费者）。
 *   spec 形 image block，wire 翻译见 llm/protocol-encode.ts case 'image'（形态细节见下方 ImageBlock 定义）。
 *
 * 与 llm/protocol-types.ts 的区别：
 *   - protocol-types 服务于 LLM 协议层翻译（anthropic wire），字段名按协议需要
 *   - 本文件是业务层权威（落库 / agent loop / context engine 共用），字段名对齐
 *     agent_message_interface.md（tool_call/tool_result/reasoning）
 *   - v0.0.8 不强制两份等价（task-7 删 /chat 后由 doc-modifier 统一）
 *
 * [v0.0.101] HITL 命名约定（architect 锁定）：
 *   - ToolResultBlock.pending 用 `subState`（运行/存储侧的子状态）
 *   - ToolInteraction（tools/types.ts）用 `subType`（作者侧返回的类型标签）
 *   二者值域相同（'need_feedback'|'need_approval'）；命名差异是契约锁定，非笔误。
 */

// ============================================================
// 1. MessageRole
// ============================================================

/** 消息角色（对齐 message interface §1） */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 币种（与 llm/provider-types.ts Currency 同构，本地声明避免 message ↔ llm 循环依赖）。
 * 权威：specs/tech/agent/providers_and_models/convention.md §5。
 */
export type Currency = 'USD' | 'CNY';

/**
 * [v0.0.101] HITL 载荷类型仅 type-only 引用自 tools/types.ts。
 * FeedbackData / ApprovalData 在 tools/types.ts 权威定义（tool 作者侧）；
 * ToolResultBlock.data 当 status='pending' 时携带。
 * type-only 循环 import（tools/types ↔ message/types）在 TS 下无运行时影响。
 */
import type {
  FeedbackData,
  ApprovalData,
} from '../tools/types';

// ============================================================
// 2. ContentBlock 子集（v0.0.8）
// ============================================================

/** 纯文本块 */
export interface TextBlock {
  type: 'text';
  text: string;
  /** [v0.0.39] 块级 reminder 标记（v0.0.50 起为唯一权威）：injector 追加 reminder text block 时设 true。
   * 前端按块级精确过滤（只隐这一块，不影响同 message 其他 text）。
   * LLM 零侵入：protocol-encode.ts encodeContentBlock 对 text 只读 b.text，不读此字段。
   * [v0.0.50] 消息级 metadata.isSystemReminder 已废止，块级为唯一标记。 */
  isSystemReminder?: boolean;
}

/**
 * [v0.0.105] 图片来源（判别联合 by kind）。
 *   - kind='url'：远程图片链接（anthropic 支持 url 形态 image source）
 *   - kind='base64'：内联 base64 数据（**裸** base64，无 `data:image/png;base64,` 前缀；mediaType 在 ImageBlock 顶层单独携带）
 */
export type ImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'base64'; data: string };

/**
 * [v0.0.105] 图片块（截图回灌 LLM，spec §4.2）。各 role + ToolResultBlock.content 均可承载（§3 表）。
 * spec 形（source.kind 判别联合 + mediaType 顶层）≠ anthropic wire 形（source:{type,media_type,data}）；
 * 翻译由 protocol-encode.ts encodeContentBlock case 'image' 负责，禁在别处直接透传 source。
 */
export interface ImageBlock {
  type: 'image';
  /** 图片来源（url 远程 / base64 内联，判别联合 by kind） */
  source: ImageSource;
  /** MIME 类型（"image/png" | "image/jpeg" | "image/webp" | "image/gif"），wire 层填入 source.media_type */
  mediaType: string;
}

/**
 * 工具调用块（assistant 发起）。
 * 字段名严格对齐 message interface §4.6：id / name / arguments
 */
export interface ToolCallBlock {
  type: 'tool_call';
  /** ULID 或 LLM 返回的 id（关联 ToolResultBlock.toolCallId） */
  id: string;
  /** 工具名称 */
  name: string;
  /** 调用参数（JSON 对象） */
  arguments: Record<string, unknown>;
}

/**
 * 工具结果块（tool 角色消息携带）。
 * 字段名严格对齐 message interface §4.7：toolCallId / content / isError
 *
 * [v0.0.101] 加顶层 status 三态（向后兼容：缺省视 'success'）：
 *   - 'success'：正常结果（默认；旧数据无字段等同此）
 *   - 'pending'：悬挂占位（HITL 待用户回答），此时 subState + data 必填
 *   - 'fail'：执行出错（isError=true）
 *
 * status='pending' 时：
 *   - content 为人话占位（如「用户回答中…」），LLM 首次消费前可被回填编辑（INV-6）
 *   - subState：渲染分发 key（前端据此选提问卡 need_feedback / 审批卡 need_approval）
 *   - data：交互载荷（FeedbackData / ApprovalData）
 *   - isError 保持 false（pending 不是错误态）
 */
export interface ToolResultBlock {
  type: 'tool_result';
  /** 关联到 ToolCallBlock.id */
  toolCallId: string;
  /** 结果内容（可嵌套 TextBlock 等） */
  content: ContentBlock[];
  /** 是否执行出错 */
  isError: boolean;
  /** [v0.0.101] 工具结果状态（缺省视 'success' 向后兼容旧数据；新消息建议显式标注） */
  status?: 'success' | 'pending' | 'fail';
  /** [v0.0.101] status='pending' 时必填：渲染分发 key */
  subState?: 'need_feedback' | 'need_approval';
  /** [v0.0.101] status='pending' 时必填：交互载荷（subState 决定具体类型） */
  data?: FeedbackData | ApprovalData;
}

/**
 * [v0.0.101] 用户回填答案（提问卡提交的 payload）。
 * 参考: reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §5
 *
 * selections 按 Question.id 索引；值数组（single 时长度 1，multi 时任意）；
 * 「其他」自填文本以「其他：<text>」格式放入值数组（前端构造）。
 */
export interface FeedbackAnswer {
  /** 按 questionId 索引的答案；值含「其他：<text>」格式 */
  selections: { [questionId: string]: string[] };
}

/**
 * [v0.0.101] 审批决策（审批卡 allow/deny 的 payload，本版 spec 留位不实例）。
 * - decision='allow' 时 modifiedArguments 可选携带修改后的参数（补跑原 tool 用）
 * - decision='deny' 时无 modifiedArguments
 */
export interface ApprovalDecision {
  /** 用户决策：allow=允许（补跑原 tool）/ deny=拒绝 */
  decision: 'allow' | 'deny';
  /** allow 时可携带修改后的参数（覆盖原 ToolCallBlock.arguments 补跑） */
  modifiedArguments?: unknown;
}

/**
 * [v0.0.101] tool_reply ContentBlock — 用户回填 tool 调用的答案/审批时携带。
 * 参考: reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §6/§11
 *
 * 进 user message 的 content 数组；handleType 决定 payload 形态：
 *   - direct_result：FeedbackAnswer（ask-question 的答案）
 *   - approval：ApprovalDecision（审批卡决策）
 *   - callback：unknown（tool.onReply 自定义，扩展点）
 *
 * 与 ToolResultBlock 的关系：tool_reply 是 user 角度的「答案信封」，
 * pre-process 据此回填对应占位 ToolResultBlock（status pending→success/fail）。
 */
export interface ToolReplyBlock {
  type: 'tool_reply';
  /** 关联到 ToolCallBlock.id（回填匹配 key） */
  toolCallId: string;
  /** 回填处理分发 key（pre-process 据此三分发：direct_result/approval/callback） */
  handleType: 'direct_result' | 'approval' | 'callback';
  /** 答案 payload（按 handleType 分发：direct_result→FeedbackAnswer / approval→ApprovalDecision / callback→unknown） */
  payload: FeedbackAnswer | ApprovalDecision | unknown;
}

/** 思维链块（后端落库 + 传 LLM；前端不渲染） */
export interface ReasoningBlock {
  type: 'reasoning';
  text: string;
}

/**
 * Usage 块（后端 emit；前端不渲染）。
 * usage 字段为 LLM 调用用量（具体形状归 session_usage.md，v0.0.8 透传）。
 */
export interface UsageBlock {
  type: 'usage';
  usage: Usage;
}

/**
 * ContentBlock 联合（v0.0.8 子集 + v0.0.101 tool_reply + v0.0.105 image）。
 * 共 7 类：text / image / tool_call / tool_result / reasoning / usage / tool_reply（旧数据无 image，向后兼容）。
 * AudioBlock/VideoBlock/FileBlock/ApprovalResultBlock 仍标 future 不实现。
 */
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolCallBlock
  | ToolResultBlock
  | ReasoningBlock
  | UsageBlock
  | ToolReplyBlock;

// ============================================================
// 3. Usage（v0.0.10 补全至 spec 完整字段集）
// ============================================================

/**
 * LLM 一次调用的用量（token + char + cost）。
 * 权威定义：specs/tech/agent/session/[P0]session_usage.md §1。
 *
 * 字段集对齐 spec §1（input_cache_read / input_cache_write / input_no_cache /
 * input_total_tokens / output_response / output_reasoning / output_total_tokens /
 * total_tokens / cost / currency? / inputCharCount / outputCharCount）。
 *
 * optionality 策略：spec §1 要求 token 字段必填，但 impl 数据流是**渐进到达**
 * （anthropic message_delta 只带 input_tokens/output_tokens，cache 字段仅当命中
 * prompt caching 才出现；cost/currency 由 client.computeCost 在 call() 末尾填）。
 * 为兼容流式途中部分字段语义，所有字段保留 optional，但**去除 loose 索引签名**
 * （避免任意 key 透传掩盖字段缺失）。字段名严格对齐 spec，便于 accumulateUsage 按
 * 字段 Σ 累加（session_usage.md §2）。
 */
export interface Usage {
  // ── token（LLM 真实返回；llm/protocol-parse-stream.parseAnthropicUsage 翻译）──
  /** 命中缓存的输入 token（anthropic: cache_read_input_tokens） */
  input_cache_read?: number;
  /** 写入缓存的输入 token（anthropic: cache_creation_input_tokens） */
  input_cache_write?: number;
  /** 未缓存的普通输入 token（anthropic: input_tokens - cache_read - cache_write） */
  input_no_cache?: number;
  /** 输入 token 总数 = cache_read + cache_write + no_cache（spec §1） */
  input_total_tokens?: number;
  /** 实际回复内容 token（anthropic: output_tokens） */
  output_response?: number;
  /** 思维链 token（anthropic: 部分 model reasoning 单独计；无则 0） */
  output_reasoning?: number;
  /** 输出 token 总数 = output_response + output_reasoning（spec §1） */
  output_total_tokens?: number;
  /** 总 token = input_total_tokens + output_total_tokens（spec §1） */
  total_tokens?: number;
  /** 金额（vendor 返回或 client.computeCost 算；原币种，见 currency） */
  cost?: number;
  /** 币种（见 convention.md §5；client 填 modelConfig.pricing.currency） */
  currency?: Currency;

  // ── char（估算基准，学 ratio 用；assemble / client 统计）──
  /** assemble snapshot 产出的 input char（= snapshot.inputCharCount） */
  inputCharCount?: number;
  /** llm client 统计的 output char（LLM 实际输出的 char） */
  outputCharCount?: number;
}

/**
 * ContextWindowUsage — snapshot 级 context window 用量（v0.0.16 扩 7 字段，对齐
 * context_snapshot_interface.md §2 + context_usage_detail.md §3）。
 *
 * 字段语义：
 *   - systemTokens / messageTokens / toolTokens：分项 input token（char × ratio 估算）
 *   - totalTokens：input 侧总 token = 三分项之和（不含 maxOutputTokens）
 *   - maxOutputTokens：输出预算（AppConfig `context.maxOutputTokens` 缺省 20000；v0.0.89 自 DevConfig 迁入 AppConfig）
 *   - tokenLimit：model context window（modelConfig.contextWindow）
 *   - remainingTokens：剩余可用 input = tokenLimit − totalTokens − maxOutputTokens（< 0 触发 compact）
 *
 * v0.0.16 前 v0.0.8 简化版仅 3 字段（tokenLimit/usedTokens/remainingTokens），
 * `usedTokens` 等价于当前 `totalTokens`。反序列化旧 record 时用 `normalizeContextWindowUsage`
 * 补全（见 session-usage-helper.ts）。
 */
export interface ContextWindowUsage {
  /** system prompt token（char × ratio 估算） */
  systemTokens: number;
  /** messages token（char × ratio 估算） */
  messageTokens: number;
  /** tools 定义 token（char × ratio 估算） */
  toolTokens: number;
  /** input 侧总 token = system + message + tool（不含 maxOutputTokens） */
  totalTokens: number;
  /** 输出预留（默认 20000，AppConfig `context` 组；v0.0.89 自 DevConfig 迁入 AppConfig） */
  maxOutputTokens: number;
  /** 模型 context window（modelConfig.contextWindow） */
  tokenLimit: number;
  /** 剩余可用 input token = tokenLimit − totalTokens − maxOutputTokens */
  remainingTokens: number;
}

// ============================================================
// 4. MessageSender / MessageSource（v0.0.31 判别联合化）
// ============================================================

/**
 * 消息来源类型（对齐 message interface §5）。
 * v0.0.31：'scheduled' 并入 'system'（heartbeat/cron/reminder 均为 system 子类）。
 * v0.0.101：加 'tool_reply'（用户回填 HITL 答案/审批，走 inbox 投递）。
 */
export type MessageSource = 'user' | 'agent' | 'approval' | 'system' | 'tool_reply';

/**
 * AgentRef —— a2a 寻址结构（[P1]a2a_protocol.md §2）
 * type=对端 session.type；sessionId=路由主键；name=人类可读名。
 * 存储永远是完整 struct（无歧义）。
 */
export interface AgentRef {
  /** 对端类型（不含 user——user 不在 a2a 拓扑里）。'leader'/'mate'/'squad'/'rocky'/'subagent'；
   *  [v0.0.56] 'session' → 'rocky'（Role 收敛）；'subagent' 保留（a2a 拓扑需区分） */
  // [v0.0.33.1] member→mate（B 方案命名统一，design.md §5）
  type: 'leader' | 'mate' | 'subagent' | 'squad' | 'rocky';
  /** 路由主键（inbox 在该 sessionId 下） */
  sessionId: string;
  /** 人类可读名（leader/mate RoleSpec.name；subagent/squad 用系统名；'session' 用 title） */
  name: string;
}

/**
 * sender.agent 子结构（[P1]a2a_protocol.md §4 / §5）。
 * 仅 source='agent' 时携带；承载 a2a 信封：发送方 ref + 是否需回复 + 回复关联 messageId。
 */
export interface MessageSenderAgent {
  /** 发送方 AgentRef（接收方 send_message(to=ref) 回复） */
  ref: AgentRef;
  /** 是否需要回复（true=接收方完成/收到后必 send_message 回；false=fyi/通知） */
  needReply: boolean;
  /** 关联原 message.id（thread 线索；首任务无 parent message 不填） */
  inReplyTo?: string;
}

/**
 * sender.channel 子结构（D5：IM 渠道入站消息的来源信封）。
 * 仅 source='user' + channel? 时携带；标识该用户消息来自哪个 IM 渠道配置 + 会话 + IM 用户。
 * 参考: specs/tech/channel/[P0]channel_impl_interface.md §5.1
 */
export interface MessageSenderChannel {
  /** 渠道 impl 类型标识（= ChannelConfig.implId，如 'feishu'；web client 缺省语义 'client'）。 */
  type: string;
  /** ChannelConfig.id（渠道配置 id，ULID） */
  configId: string;
  /** 会话 id（飞书群=chatId / 私聊=openId，无 scope 编码 D2） */
  conversationId: string;
  /** IM 用户 id（飞书=open_id） */
  imUserId: string;
  /** IM 用户名（飞书=user_name，可能为空） */
  imUserName: string;
}

/**
 * MessageSender = 严格判别联合（discriminated union by `source`）。
 *
 * 权威：specs/tech/agent/message/[P0]agent_message_interface.md §5
 *   —— v0.0.31 落实，从「optional 子结构 + 扁平残留」升级为严格判别联合。
 *
 * 每个 source 变体是独立子结构；TS 在 `if (sender.source === 'agent')` 后窄化拿 agent 子字段。
 * needReply / sender.agent 子结构 = source='agent'（a2a）专属，user/system/approval 不存在此字段
 * （结构层钉死，防「user 消息误读 needReply」）。
 *
 * ★ 程序构造性原则（关键）：sender 信封（source/agent.ref/needReply/inReplyTo）是**程序构造**的，
 *   不是 LLM 构造的。LLM 入口只有 agent.spawn / send_message（一定 a2a），LLM 只传工具入参
 *   （target/content/needReply/inReplyTo）+ AgentRef；message 信封由程序组装（source 硬编码按入口、
 *   ref 从 runtime context、needReply/inReplyTo 透传 LLM 入参）。LLM 从不直接构造/看到 sender 结构。
 *   故判别联合的价值 = **程序内部类型安全**（防程序构造/读取 sender 时的代码 bug），类型形态是程序
 *   内部细节，coding 保证即可。
 *
 * 旧字段清理：原 `agentName?` / `agentId?` 扁平标量（早期数据临时字段，v0.0.28 已子结构化但留 optional）
 * 本版彻底删除——判别联合下无歧义，无遗留。
 */
export type MessageSender =
  | {
      /** a2a（agent→agent） */
      source: 'agent';
      /** 发送方完整 ref + 回复信封（AgentRef + needReply + inReplyTo） */
      agent: MessageSenderAgent;
    }
  | {
      /** 用户消息（web client / IM 渠道对等入口） */
      source: 'user';
      /**
       * IM 渠道来源（D5：channel=client 对等，不扩 source 枚举）。
       * 仅当消息从 IM 渠道（飞书）入站时填充；web client 消息无此字段（向后兼容）。
       * 参考: specs/tech/channel/[P0]channel_impl_interface.md §5.1
       */
      channel?: MessageSenderChannel;
    }
  | {
      /** 系统消息（heartbeat/cron/reminder/scheduled，scheduled 已并入 system） */
      source: 'system';
      /** 子类（"heartbeat"|"cron"|"reminder"|...，开放，按需扩） */
      system: { kind: string; refId?: string };
    }
  | {
      /** 审批回流 */
      source: 'approval';
      approval: {
        /** 关联 ToolCallBlock.id */
        toolCallId: string;
        decision: 'allow' | 'allow_always' | 'deny';
      };
    }
  | {
      /**
       * [v0.0.101] tool_reply：用户回填 HITL 答案/审批（走 inbox，POST /messages tool_reply 分支构造）。
       * pre-process 识别此 source 走回填分支（不进普通 user/system 分流）。
       */
      source: 'tool_reply';
      /** 回填定位（关联到原 ToolCallBlock + run） */
      tool_reply: {
        /** 配对 ToolCallBlock.id（回填匹配 key） */
        toolCallId: string;
        /** 触发悬挂的 run id（恢复时校验归属） */
        runId: string;
      };
    };

// ============================================================
// 5. Message（业务权威形态）
// ============================================================

/**
 * 业务 Message（对齐 message interface §5）。
 *
 * 业务 put 时只填以下字段：id/sessionId/role/content + 可选 runId/sender/metadata。
 * 信封字段 createdAt/updatedAt/version 由 CrudStore 注入（schema 不声明，见
 * persistence/[P0]crud_store_interface.md §2.1），读取返回的 Message 已含信封。
 */
export interface Message {
  /** 消息 ULID（业务生成） */
  id: string;
  /** 所属会话 ULID */
  sessionId: string;
  /** 消息角色 */
  role: MessageRole;
  /** 内容块数组（transcript 形态：首次发给 LLM 的样子） */
  content: ContentBlock[];
  /** 关联的 agent run ULID（可选） */
  runId?: string;
  /** 消息来源标记 */
  sender?: MessageSender;
  /** 扩展元数据。消息级 isSystemReminder 已于 v0.0.50 废止（块级 TextBlock.isSystemReminder 唯一权威）；
   * 其他 kv（rawRef / toolResultRef 等）仍存活于此字段。 */
  metadata?: Record<string, unknown>;

  // ── store 信封（CrudStore 注入，业务 put 不传）──
  // optionality 说明：spec message_interface §5 要求读取返回的 Message 信封必填，
  // 但 impl 业务代码多处直接构造 Message 作内部数据结构（context-engine 的 system
  // message、测试 fixture），此时信封尚未注入。故 impl 层保持 optional，
  // 去 readonly（task-6：去掉不当 readonly，允许构造后赋值）；store 读取返回时
  // 由 converter 保证必填（见 session-store-converters.ts）。
  /** 首次写入时间（isoDate，store 注入） */
  createdAt?: string;
  /** 最近写入时间（isoDate，store 注入） */
  updatedAt?: string;
  /** 乐观锁版本号（store 注入，首次为 1） */
  version?: number;
}

/** 业务 put 时使用的形态（剥离信封字段） */
export type MessageInput = Omit<Message, 'createdAt' | 'updatedAt' | 'version'>;
