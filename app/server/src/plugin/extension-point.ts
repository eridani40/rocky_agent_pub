/**
 * ExtensionPoint 定义 + 内置扩展点常量
 * 参考: specs/tech/plugin_system/[P0]extension_point_interface.md §2/§3/§4
 *       specs/tech/plugin_system/[P0]overview.md §2.5（管理架构）
 *
 * 设计（ext_point §3.5）：契约由泛型 TContract 携带，是类型不是运行时字段；
 * 运行时身份用 id。cardinality 只是管理策略（§3.1），决定注册表存取形状，
 * 不规定运行时组合（下放 consumer）。
 *
 * 本文件只含「类型定义」与「内置常量」，无运行时逻辑。
 */

/**
 * 扩展点：一个有名字的契约槽位，带 cardinality 决定注册表如何消费多个 ext impl。
 *
 * v0.0.71（D1）：删除 `group` 字段——group 归属迁到外部 `app/plugins/groups.json`
 * 元数据源（T1 产出）。EP 自身只保留运行时身份字段（id/cardinality/description），
 * inventory group-centric 聚合改由 GroupMetaProvider JOIN 提供（见 change_plan 模块 2）。
 * @template TContract 该扩展点的契约接口（类型，非运行时字段）
 */
export interface ExtensionPoint<TContract = unknown> {
  /** 扩展点唯一 id，snake_case（如 "llm_provider"、"context_engine"） */
  id: string;
  /** 注册表如何消费多个 ext impl：exclusive=独占≤1 / list=无序并存 / ordered=按 order 排序 */
  cardinality: 'exclusive' | 'list' | 'ordered';
  /**
   * EP 级描述（inventory 透传 pointDescription，UI EP header 呈现）。
   * 代码硬编码（EP 定义常量），不进 plugin_policy 配置。一句话说明该 EP 干什么。
   * 参考: design §4.1 / specs/tech/plugin_system/[P0]extension_point_interface.md
   */
  description?: string;
}

/**
 * llm_provider 扩展点：list cardinality，承载鉴权行为（无状态代码）。
 * 契约 LlmProvider 见 agent/providers_and_models/[P0]llm_provider_interface.md。
 * TContract 此处留 unknown（具体契约接口归 agent 模块，plugin 模块不依赖）。
 */
export const LlmProviderPoint: ExtensionPoint = {
  id: 'llm_provider',
  cardinality: 'list',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.llm_provider.description__',
};

/**
 * llm_protocol 扩展点：list cardinality，承载请求翻译 + path/contentType（无状态代码）。
 * 契约 LlmProtocol 见 agent/providers_and_models/[P0]llm_protocol_interface.md。
 */
export const LlmProtocolPoint: ExtensionPoint = {
  id: 'llm_protocol',
  cardinality: 'list',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.llm_protocol.description__',
};

// ============================================================
// v0.0.13 context 子系统 6 个 EP（cardinality="ordered"）
// v0.0.71（D1）：group 归属迁到 app/plugins/groups.json（context-ingest/context-assemble/system-prompt）
// 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §2
//       specs/tech/agent/context_and_memory/[P0]context_engine.md §3.5（ContextEngine 如何调框架）
// ============================================================

/** context_ingest_handler：ingest 落库前 ordered transform 链（Message[] → Message[]） */
export const ContextIngestHandlerPoint: ExtensionPoint = {
  id: 'context_ingest_handler',
  cardinality: 'ordered',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.context_ingest_handler.description__',
};

/** context_assemble_mapper：assemble 读数据源 ordered 链（map → deepMerge） */
export const ContextAssembleMapperPoint: ExtensionPoint = {
  id: 'context_assemble_mapper',
  cardinality: 'ordered',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.context_assemble_mapper.description__',
};

/** context_assemble_reducer：assemble 增量组装 ordered 链（reduce → Message[]） */
export const ContextAssembleReducerPoint: ExtensionPoint = {
  id: 'context_assemble_reducer',
  cardinality: 'ordered',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.context_assemble_reducer.description__',
};

/**
 * context_clean_view_reducer：喂 LLM 前的「清理视图」ordered 链（v0.0.173 新增）。
 *
 * 设计动机（v0.0.173 snapshot 稳定化重构）：把原挂在 assemble_reducer 链尾的 6 个清理类
 * reducer（snip_handler / orphan_tool_call / think_remove / fill_empty_text / empty_message /
 * role_merge）剥到独立 EP，由 ContextEngine.getCleanSnapshot 在深克隆后跑——snapshot 自身
 * 永远保持 rebuild 确定性纯函数（不被清理污染），清理只作用在喂 LLM 的视图副本上。
 *
 * 与 ContextAssembleReducerPoint 同构（ordered），承接 LLM 视角的清理；base_builder 留在
 * assemble_reducer（snapshot 构建），其他 6 个迁过来。
 */
export const ContextCleanViewReducerPoint: ExtensionPoint = {
  id: 'context_clean_view_reducer',
  cardinality: 'ordered',
  // [v0.0.62 i18n] description 走 __MSG_<key>__ 占位符（与现有 6 个 context EP 一致）
  description: '__MSG_extpoint.context_clean_view_reducer.description__',
};

/** system_prompt_mapper：system prompt 贡献 ordered 链（map → concat PromptFragment[]） */
export const SystemPromptMapperPoint: ExtensionPoint = {
  id: 'system_prompt_mapper',
  cardinality: 'ordered',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.system_prompt_mapper.description__',
};

/** system_prompt_reducer：system prompt 链式处理 ordered 链（reduce → PromptFragment[]） */
export const SystemPromptReducerPoint: ExtensionPoint = {
  id: 'system_prompt_reducer',
  cardinality: 'ordered',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.system_prompt_reducer.description__',
};

/** system_reminder：reminder provider ordered 链（provide → concat SystemReminder[]） */
export const SystemReminderPoint: ExtensionPoint = {
  id: 'system_reminder',
  cardinality: 'ordered',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.system_reminder.description__',
};

// ============================================================
// v0.0.40 compact 触发 2 个 exclusive context EP（首批 exclusive context EP）
// v0.0.71（D1）：group 归属迁到 app/plugins/groups.json（context-compact）
// 参考: specs/tech/agent/context/[P0]extension point and implementations.md §2/§3.7
//       specs/tech/agent/context/[P0]context_compact_detail.md §2c
// ============================================================

/**
 * context_should_compact：compact 触发谓词（exclusive ≤1 active）。
 * 契约 ShouldCompactPredicate.check(ctx) → boolean（详见 context_compact_detail §2c）。
 *
 * **防递归**：summary/consolidate scope 显式选中 `reject_should_compact`（dummy，恒返 false）→
 * getExtensionImpls 返该 impl → tryCompact 在谓词检查处 return（旁路 run 永不 compact）。
 */
export const ContextShouldCompactPoint: ExtensionPoint = {
  id: 'context_should_compact',
  cardinality: 'exclusive',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.context_should_compact.description__',
};

/**
 * context_do_compact：compact 执行动作（exclusive ≤1 active）。
 * 契约 DoCompactAction.run(ctx) → Promise<void>（详见 context_compact_detail §2c）。
 * 默认 impl summary_do_compact = sideRun(summary,NO_TOOLS) → extractTag → setSummary。
 */
export const ContextDoCompactPoint: ExtensionPoint = {
  id: 'context_do_compact',
  cardinality: 'exclusive',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.context_do_compact.description__',
};

/**
 * context_post_compact：compact 成功完成后触发的 ordered handler 链（v0.0.51 新增）。
 * 契约 PostCompactHandler.handle(ctx) → Promise<void>（详见 context_compact_detail §2d）。
 *
 * 触发时机：summary_do_compact 完成（setSummary + appendMessages + markSummaryDone）后，
 * 由 tryCompact 胶水尾部循环调用 active handlers（每个 handler try/catch 隔离，失败不影响
 * compact 已完成的 summary）。
 *
 * 默认 impl memory_skill_consolidation = 启动 fork-2 整理旁路 agent（allowed tools =
 * [skill_manage, memory_manage]，见 consolidation_tier1 §3）；consolidate scope 显式 disable
 * memory_skill_consolidation（保留 noop_post_compact）防递归整理（spec §2d.4）。
 */
export const ContextPostCompactPoint: ExtensionPoint = {
  id: 'context_post_compact',
  cardinality: 'ordered',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.context_post_compact.description__',
};

/**
 * v0.0.66 session_store 扩展点：exclusive，承载 per-session 上下文存储实现。
 * 参考: reqs/[working] v0.0.66/design.md §1.1/§2.1
 *
 * 设计动机：default/forked 用同一套 assemble/ingest 主干逻辑，差异靠 store 实现 + scope 配置驱动。
 *   - default scope 选中 `persistent_session_store`（包装现有持久 SessionStore，全方法）
 *   - forked  scope 选中 `in_memory_session_store`（新建，只实现 appendMessages + getMessages；
 *     getSummary 返 null 不 throw 便于 assemble 统一逻辑；其他方法 unsupported）
 *
 * exclusive cardinality：同 scope ≤1 active（default/forked 各自选中一个）。
 * 契约见 `app/plugins/builtins/rocky_context/types.ts` 的 `SessionStoreContract`（结构等价 SessionStore 子集）。
 */
export const SessionStorePoint: ExtensionPoint = {
  id: 'session_store',
  cardinality: 'exclusive',
  description: '__MSG_extpoint.session_store.description__',
};

// ============================================================
// v0.0.23 web 子系统 EP
// v0.0.71（D1）：group 归属迁到 app/plugins/groups.json（web）
// 参考: specs/tech/agent/tools/[P1]web_search_tool.md §3
// ============================================================

/**
 * web_search_provider：list，承载可插拔搜索后端（多 impl 共存，按 app_config.type 单点路由）。
 * [v0.0.72] cardinality 由 exclusive 改 list（多 search 供应商可同时安装，无需先卸载旧的）；
 * tool 按 app_config.web_search.type 在 list 中精确选一个 impl 调用，不并发融合。
 * 契约 WebSearchProvider 见 web-search/types.ts（agent/tools 模块）。
 */
export const WebSearchProviderPoint: ExtensionPoint = {
  id: 'web_search_provider',
  cardinality: 'list',
  // [v0.0.62 i18n] description 改为 __MSG_<key>__ 占位符（前端 resolveI18nField 查 plugin-config ns）
  description: '__MSG_extpoint.web_search_provider.description__',
};

// ============================================================
// v0.0.103 channel 子系统 EP（IM 渠道接入层）
// 参考: specs/tech/channel/[P0]channel_extension_point.md §2
//
// 设计：channel = IM 渠道接入层（飞书/未来微信/钉钉），与 web client 并列的消息接入路径。
// cardinality='list' —— 多 IM 平台并存（飞书 + 微信 + 钉钉同连），一个 impl 可有多份 instance。
// 契约 Channel interface（5 方法）见 specs/tech/channel/[P0]channel_impl_interface.md §2
// ============================================================

/**
 * channel 扩展点：list cardinality，承载 IM 渠道接入层（与 client 对等的消息路径）。
 * 多 IM 平台并存，ChannelManager 按 channel_config instance.implId 取 impl 类。
 */
export const ChannelPoint: ExtensionPoint = {
  id: 'channel',
  cardinality: 'list',
  description: '__MSG_extpoint.channel.description__',
};

// ============================================================
// v0.0.141 see_image 子系统 EP（视觉理解工具）
// group=vision 归属在 app/plugins/groups.json（D1 起 group 迁外部元数据源）
// 参考: specs/tech/agent/tools/[P1]see_image_tool.md §3
// ============================================================

/**
 * see_image_provider：list，承载可插拔视觉理解后端（多 impl 共存，按 app_config.see_image.type 单点路由）。
 * 与 web_search_provider 完全同构：cardinality='list' 只是注册表存取形状，
 * tool 层按 type 精确选一个 impl 调用，不并发融合。
 * 契约 SeeImageProvider 见 see-image/types.ts（agent/tools 模块）。
 */
export const SeeImageProviderPoint: ExtensionPoint = {
  id: 'see_image_provider',
  cardinality: 'list',
  description: '__MSG_extpoint.see_image_provider.description__',
};

// ============================================================
// v0.0.166 skill_market 子系统 EP（skill 市场源接入层）
// group=skill-market 归属在 app/plugins/groups.json
// 参考: specs/tech/agent/skills/[P1]skill_market.md §4
// ============================================================

/**
 * skill_market_provider：exclusive，承载可替换的 skill 市场源（同一时刻只有一个生效）。
 * 范式抄 SessionStorePoint（≤1 active），**非** WebSearchProviderPoint 的 list——
 * skill 市场是「整源替换」心智（skills.sh → 未来 ClawHub / git 自建），不需多源共存 + type 切换。
 * 生效 impl 由 scope 配置 `impls` 列表决定（v0.0.179 membership 模型：列表恰好 1 项），resolve 取 getExtensionImpls[0]。
 * 契约 SkillMarketProvider 见 tools/skill-market/types.ts（agent/tools 模块）。
 */
export const SkillMarketProviderPoint: ExtensionPoint = {
  id: 'skill_market_provider',
  cardinality: 'exclusive',
  description: '__MSG_extpoint.skill_market_provider.description__',
};

/**
 * 内置扩展点注册表（供 builtin-loader 注册 + inventory JOIN 用）。
 * 增加新内置 EP 时在此 append。
 */
export const BUILTIN_EXTENSION_POINTS: readonly ExtensionPoint[] = [
  LlmProviderPoint,
  LlmProtocolPoint,
  // v0.0.13 context 子系统 6 EP（+ v0.0.173 新增 context_clean_view_reducer，同块相邻）
  ContextIngestHandlerPoint,
  ContextAssembleMapperPoint,
  ContextAssembleReducerPoint,
  ContextCleanViewReducerPoint,
  SystemPromptMapperPoint,
  SystemPromptReducerPoint,
  SystemReminderPoint,
  // v0.0.40 compact 触发 2 个 exclusive context EP（首批 exclusive context EP）
  ContextShouldCompactPoint,
  ContextDoCompactPoint,
  // v0.0.51 compact 后 ordered handler EP（post-compact 整理）
  ContextPostCompactPoint,
  // v0.0.66 session store exclusive EP（default/forked 切实现）
  SessionStorePoint,
  // v0.0.23 web 子系统 EP
  WebSearchProviderPoint,
  // v0.0.103 channel 子系统 EP（IM 渠道接入层，飞书 ExtImpl）
  ChannelPoint,
  // v0.0.141 see_image 子系统 EP（视觉理解工具）
  SeeImageProviderPoint,
  // v0.0.166 skill_market 子系统 EP（skill 市场源，exclusive 整源替换）
  SkillMarketProviderPoint,
];
