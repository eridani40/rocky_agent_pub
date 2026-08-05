# v0.0.155 变更计划书 — chat 模型配置 session 中心化 + ModelRef 复合 + 三统一 + 两层 base

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 位置 / 原则编号 |
| 影响行 | +N / -M |

---

## 0. 前置事实核实（architect 已 grep 核实，作为契约基线）

1. **session 已有四字段**：`providerId? / modelId? / effort? / approvalMode?`（`app/server/src/agent/session-store-types.ts:74,76,187,193`）。后端类型早已就绪。
2. **PUT /session/:id body 已支持四字段**：`UpdateSessionBody`（`app/server/src/handlers/session-deps.ts:156-172`）已含 `{title?, providerId?, modelId?, effort?, approvalMode?}`。**无需扩展 API** — session 统一接口已就绪。
3. **effort / approvalMode 读路径**：`session.effort → config.effort → CallLLMInput.effort`（`agent-loop-stage-llm.ts:130`）；`session.approvalMode → config.approvalMode → tools/engine.ts:196`。**纯 session-only 读，无跨 member 绕行**。本版本不改这两条读路径（已经对）。
4. **model 读路径（A3 核心）**：`session-config.ts:203 resolveModel(input)` → `model-resolver.ts:188-191 buildFallbackChain` 读 `member?.model` 作为 leader/mate chat/summary 链 fallback → **这是「session 读 config 绕 member」的唯一脏点**。
5. **member.model 写入入口（A4 决策依据）**：`POST /squad/:id/member` body.model（`handlers/member.ts:148-157,181`）、`PATCH /squad/:id/member/:mid` body.model（`handlers/member.ts:239`）、team 工具 `team-write-actions.ts:64` hire schema `model` 字段。**仅 squad 配置时写入，非 chat-runtime**。
6. **squad.modelDefault 是纯 string**（`agent/schema_defs/squad/squad.ts:37`）；`summaryModelDefault` 同。
7. **三 chat 页主区结构 ~90% 共用**：topbar (title + tag + UsagePanel + CompactBtn + ClearBtn) / ComponentMessageStream + right-overlay wrapper / ChatComposer + button row input bar；差异在 chrome 源 / 状态机 / 左右栏 slot / model 持久化 / actor+filter。
8. **studio 单聊 picker 当前走 patchMember**（`component-member-chat-input-bar.tsx:100` body `{model: sel.modelId}`）；**playground picker 走 updateSession**（`page-chat.tsx:148-152` 复合 body）；**群聊 picker 走 per-call body override**（`section-squad-chat.tsx:142-146`）。

## 0.1 A4 决策（member.model 字段去留）

**决策：完全删除 member.model 字段**（硬删，符合用户原则「member 退管理概念 = name/role/intro/tools/skillConfig，不含 model」）。

理由：① resolver 不再读它（A3），字段变 dead；② 保留 = 死代码（违反原则「不遗留死代码」）；③ 保留作「新建 session 初始值」引入新链路（建 session 时拷贝到 session.modelId），复杂度 vs 收益不划算（picker 现在就直接 updateSession，无需间接路径）。

**影响**：hire/PATCH member API body.model 不再接受；team 工具 hire schema 去 model 字段；squad admin UI（如有 member.model 设置项）去掉。存量 member.model 值忽略（resolver 已不读，无 migration 需要）。

---

## 1. 变更清单

### 段 A — 后端：session 读取链路去 member + ModelRef 复合（核心）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| model_resolver | app/server/src/services/model-resolver.ts | ResolveModelInput | 修改 | 删 `member?: { model?: string }` 字段（member.model 不再参与 resolve 链）；保留 squad/bodyOverride/sessionModelId | MUST NOT 读 member.model；MUST 保持 squad.modelDefault 作为团队级 fallback（非「绕」，是合法 team-default） | req §0.3 §0.4；原则 A3 | +2/-6 |
| model_resolver | app/server/src/services/model-resolver.ts | buildFallbackChain | 修改 | studio leader/mate chat 链：`bodyOverrideModelId → sessionModelId → resolveDefaultModel(input,'chat')`（删 `member?.model`）；summary 链：`resolveDefaultModel(input,'summary') → squad.modelDefault`（删 `member?.model`）；playground chat 链：`bodyOverrideModelId → sessionModelId → resolveDefaultModel(input,'chat')`（替换原直调 `readPlaygroundDefault`）；playground summary 链：`resolveDefaultModel(input,'summary') → sessionModelId → resolveDefaultModel(input,'chat')`（替换三处散乱 `readPlaygroundDefault` 调用） | MUST NOT 任何分支读 member.model；MUST default 步全部走 `resolveDefaultModel` 单点出口（不再 buildFallbackChain 内 inline `readPlaygroundDefault` / `squad?.modelDefault`）；row 1-6 fallback 顺序与 PRD §2.1 表对齐 | req §0.4；PRD §2.1 表 6 行；用户裁决 2026-07-16 方案 2 | +12/-14 |
| model_resolver | app/server/src/services/model-resolver.ts | resolveDefaultModel | 新增 | 统一 default 来源决策（消除原 playground/studio 散乱分支）。签名 `resolveDefaultModel(input: ResolveModelInput, task: 'chat' \| 'summary'): string \| undefined`。内部按 sessionType 分发：playground → 读 `app_config.default_models.{task}`（封装原 `readPlaygroundDefault` 行为）；studio → 读 `squad.modelDefault`（chat）或 `squad.summaryModelDefault`（summary，空 fallback `squad.modelDefault`）。**目的**：default 来源单点定义 + 可单测；`buildFallbackChain` 拼链，`resolveDefaultModel` 决定来源，职责分清 | MUST playground 仅读 app_config.default_models；MUST studio 仅读 squad.{summary,}modelDefault；MUST NOT 跨来源（playground 读 squad / studio 读 app_config）；MUST NOT 给 studio 加 app_config fallback（squad.modelDefault 必填保持，未设 → 链跑空 → throw，语义不变）；MUST 复用 `isReservedModelId` 保留字判定；readPlaygroundDefault 可作为 internal helper 保留或内联（coder 定，内部实现细节） | 用户裁决 2026-07-16 方案 2（统一代码 + 来源参数化）；[P0]model_resolve.md §3 表 / §4 原则 2；原则 #2 studio 禁读 default_models | +24/-0 |
| model_resolver | app/server/src/services/model-resolver.ts | findProviderForModel | 修改 | 签名加 `providerIdHint?: string`；hint 非空 → 精确匹配该 provider 的 models；hint 空 → 保留跨 provider 反查（back-compat 救存量无 providerId 的 session/squad） | MUST 命中条件：providerIdHint 命中 provider + 该 provider models 含 modelId + model.enabled!==false；hint 空 fallback 走旧逻辑；MUST NOT 忽略 hint 做模糊 | req §B2；[P0]model_resolve.md §3.2 | +18/-4 |
| model_resolver | app/server/src/services/model-resolver.ts | resolveModel | 修改 | 候选 modelId 迭代时，若配套 providerId 已知（从 ResolveModelInput 携带）则透传给 findProviderForModel 作 hint，精确定位；providerId 缺失 fallback 跨 provider 反查 | MUST 候选链每步带 `{modelId, providerIdHint?}` 元组而非裸 string | req §B1 B2 | +12/-6 |
| model_resolver | app/server/src/services/model-resolver.ts | ResolvedModel | 修改 | 文档化：输出 `{providerId, modelId}` 为权威复合 ModelRef（hint 命中则等于输入复合；hint 空则反查结果） | 输出形状不变（已是复合） | [P0]model_resolve.md §2 | +3/-0 |
| session_config | app/server/src/handlers/session-config.ts | buildSessionConfigFromDeps | 修改 | 调 resolveModel 时不再传 `member: { model? }`；传 `squad: { modelDefault?, summaryModelDefault?, modelDefaultProviderId?, summaryModelDefaultProviderId? }`（新增 providerId 字段）；sessionPersist 已有 providerId 透传作 sessionModelId 的 hint | MUST NOT 再构 member 子集传 resolve；保持 studioContext.member 完整 Member（skills/prompt 还要用，不删 studioContext.member） | req §0.4 §A；原则 A1 A3 | +10/-6 |
| session_config | app/server/src/handlers/session-config.ts | SessionPersistInput (type) | 修改 | 新增注释：`providerId?` 明确为 session 持久 providerId（与 modelId 配对，v0.0.9 起就在），作 resolveModel hint | 字段 shape 不变 | session-store-types.ts:74 | +4/-1 |
| bootstrap | app/server/src/bootstrap.ts | setResolveConfig closure | 修改 | `studioContext.member` 保留（skills/systemPrompt 需要）；不改动 squad 传递；仅依赖 buildSessionConfigFromDeps 内部不再读 member.model | MUST 保留 member fetch（skill overlay 用）；MUST NOT 因 A3 去掉 member fetch | req §0.4；§3.2 session_config_studio.md | +2/-2 |

### 段 B — 后端：ModelRef 复合（squad 加 providerId）+ validate 复合化

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_schema | app/server/src/agent/schema_defs/squad/squad.ts | modelDefaultProviderId | 新增 | squad record 新字段 `modelDefaultProviderId?: string`（与 modelDefault 配对作复合 ModelRef）；summaryModelDefaultProviderId 同 | MUST optional（back-compat：旧 squad 无此字段，resolve 链 fallback 跨 provider）；MUST NOT required | req §B1 §B3；[P1]data_model.md | +6/-0 |
| squad_schema | app/server/src/agent/schema_defs/squad/squad.ts | summaryModelDefaultProviderId | 新增 | 同上，summaryModelDefault 的配对 providerId | optional | req §B3 | +3/-0 |
| squad_handler | app/server/src/handlers/squad.ts | CreateSquadBody / PatchSquadBody | 修改 | 新增 `modelDefaultProviderId?: string` / `summaryModelDefaultProviderId?: string` 字段；落盘时透传 | MUST optional；与 modelDefault 同存同缺（校验：若给了 providerId 而 modelDefault 为空 → 400 「providerId without modelId」） | req §B3；11-squad.md §4.5 | +8/-0 |
| squad_handler | app/server/src/handlers/squad.ts | checkModel | 修改 | 校验函数扩签名 `(svc, modelId, providerId?)`；providerId 非空 → 精确校验该 provider；空 → 走旧跨 provider 校验（back-compat） | MUST 双路：复合精确 / 纯 modelId back-compat；MUST NOT 强制要求 providerId（渐进迁移） | model-validation.ts validateModelId | +10/-4 |
| squad_handler | app/server/src/handlers/squad.ts | toSquadSummary / toSquadDetail (response mappers) | 修改 | 响应体加 `modelDefaultProviderId` / `summaryModelDefaultProviderId` 字段（透传 record） | MUST 不省略字段（前端 picker 读复合用） | 11-squad.md §4 | +4/-0 |
| squad_service | app/server/src/services/squad-service.ts | SquadRecord (type) | 修改 | 新增两字段 `modelDefaultProviderId?: string; summaryModelDefaultProviderId?: string` | optional | schema 同步 | +3/-0 |
| model_validation | app/server/src/services/model-validation.ts | validateModelId | 修改 | 签名扩 `validateModelId(svc, modelId, providerIdHint?)`；hint 非空 → 精确匹配该 provider；空 → 跨 provider 反查（back-compat 保留救存量） | MUST NOT 拒绝 hint 为空的合法 modelId（渐进迁移）；hint 命中条件：providerId 命中 + 该 provider 有此 modelId | req §B2 | +14/-3 |
| model_validation | app/server/src/services/model-validation.ts | isReservedModelId | 修改 | 文档化：保留字判定对 modelId 维度（providerId 不参与保留字判定，但复合保留语义 = modelId=='default' && providerId==undefined） | MUST 契约：复合保留 = `{providerId: undefined, modelId: 'default'}` | req §B3 | +5/-0 |

### 段 C — 后端：member.model 硬删（A4）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| member_schema | app/server/src/agent/schema_defs/squad/member.ts | model | 删除 | 字段从 schema 移除（MemberRecord不再有 model） | MUST NOT 保留为 dead | req §0.1 §A4 | +0/-4 |
| member_service | app/server/src/services/member-service.ts | resolveEffective | 修改 | 删 `model: ov.model ?? parent.model` 派生；删 `validateModelId` 调用；MemberCreateInput 去掉 model 字段 | MUST NOT 接受 input.model | req §A4；handlers/member.ts:148 | +0/-12 |
| member_handler | app/server/src/handlers/member.ts | handleHire | 修改 | 删 `body.model` 入参、删 validateModelId、HireBody 类型去 model；tools dead warn 注释保留 | MUST 旧 client 传 model → 忽略 + warn（back-compat，不 400） | req §A4 | +0/-15 |
| member_handler | app/server/src/handlers/member.ts | handlePatchMember | 修改 | 删 `body.model` 入参分支、删 validateModelId；PatchMemberBody 去 model；保留字 'model ' 开头 400 错误码分支可删 | MUST 旧 client PATCH body.model → 忽略 + warn | req §A4 | +0/-8 |
| member_store | app/server/src/agent/session-store-converters.ts 或 member-store 对应 mapper | toMember (mapper) | 修改 | 去 `model` 字段映射；存量 record.model 字段读侧忽略（lazy，无 migration） | MUST 不强制 migration（读忽略）；write side 永不再落盘 model 字段 | req §0.1 | +0/-3 |
| team_tool | app/server/src/agent/tools/team-write-actions.ts | hire schema | 修改 | 去 `model: {type:'string',...}` 字段；hire 工具不再让 LLM 指 model（leader 不可控 member 模型，符合原则「运行配置跟 session」） | MUST 雇佣时 member 不带 model；新 member session 用 squad.modelDefault 作初始 fallback | req §A4；原则 #3 | +0/-3 |
| team_tool | app/server/src/agent/tools/team-write-actions.ts | HireMemberAction input type | 修改 | 去 `model?` 字段 | - | req §A4 | +0/-2 |

### 段 D — 前端：三 picker 统一走 session（写链路）+ ModelRef 复合

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| studio_member_input | app/web/src/components/studio-page/component-member-chat-input-bar.tsx | handleModelChange | 修改 | `patchMember(squadId, memberId, {model})` → `updateSession(sessionId, {providerId, modelId})`；`handleInherit` → `updateSession(sessionId, {modelId:'default'})`（清回保留字） | MUST 写 session（不写 member）；MUST 复合 body `{providerId, modelId}` | req §A2；page-chat.tsx:148 标杆 | +6/-8 |
| studio_member_input | app/web/src/components/studio-page/component-member-chat-input-bar.tsx | memberModelSel (derived) | 修改 | 读源从 `member.model` 改为 `chrome.session.modelId/providerId`（chrome 扩展，见下行）；remove `findProviderIdByModelId` 反查（复合直接读） | MUST 不再做跨 provider 反查（复合已持久）；保留字 default 显默认态 | req §B1；page-chat.tsx useModelRestore | +4/-8 |
| studio_member_input | app/web/src/components/studio-page/component-member-chat-input-bar.tsx | Props (squadModelDefault) | 修改 | 改 `squadModelDefault: { providerId?: string; modelId: string } \| string`（支持复合 + back-compat 字符串）；InputModelPicker defaultModelId defaultModelProviderId 分开传 | MUST 字符串路径作 back-compat（旧 squad 无 providerId） | req §B1 | +3/-2 |
| studio_chrome | app/web/src/components/studio-page/use-studio-chat-chrome.ts | StudioChatChrome | 修改 | 加 `sessionModel?: { providerId?: string; modelId?: string }`（从 GET /session 响应读 providerId/modelId）；setModel 命令式 setter（乐观本地 + PUT fire-and-forget） | MUST 读源唯一 = GET /session（不读 member）；与 setEffort/setApprovalMode 同款范式 | use-studio-chat-chrome.ts:152-181 标杆；req §A2 | +14/-0 |
| studio_chrome | app/web/src/components/studio-page/use-studio-chat-chrome.ts | setModel | 新增 | 命令式 setter：`mutate(c => ({...c, sessionModel: sel}))` + `updateSession(sessionId, body)`；保留字 modelId='default' → body `{modelId:'default'}` 不带 providerId | MUST 与 setEffort 同结构（mutate + fire-and-forget） | use-studio-chat-chrome.ts:164-172 | +12/-0 |
| studio_chrome | app/web/src/components/studio-page/use-studio-chat-chrome.ts | onInit (getSession) | 修改 | 多取 `s.providerId/s.modelId` 两字段回填 sessionModel（不新增网络请求，复用已有 getSession 响应） | MUST 不新增 GET；sessionModel 为 null 当 session 无持久 model 时 | req §0.2；chrome §onInit | +3/-0 |
| squad_detail_type | app/web/src/components/studio-page/squad-types.ts | SquadDetail | 修改 | 加 `modelDefaultProviderId?: string; summaryModelDefaultProviderId?: string`（对齐后端 response mapper） | MUST optional（back-compat） | req 段 B | +2/-0 |
| squad_input_picker | app/web/src/components/chat-page/component-input-model-picker.tsx | Props | 修改 | 新增 `defaultModelProviderId?: string`；trigger 显默认时优先用复合（精确显示 provider name）；缺省 fallback 跨 provider 反查 | MUST defaultModelId + defaultModelProviderId 同时传时精确；只传 defaultModelId 走旧反查 | req §B1；ui spec component-input-model-picker §11 | +6/-2 |
| squad_input_picker | app/web/src/components/chat-page/component-input-model-picker.tsx | onChange payload | 修改 | `ModelSelection` 保持 `{providerId, modelId}` 复合（已经是）；消费方统一写复合 body | 输出形状不变 | ui spec | +0/-0 |
| squad_chat_input | app/web/src/components/studio-page/section-squad-chat.tsx | handlePickerChange | 修改 | 群聊 per-call override 语义不变；sel 复合透传到 `postMessage body.{providerId, modelId}` | MUST 保持 per-call（不持久化） | section-squad-chat.tsx:164 | +0/-1 |
| page_chat | app/web/src/components/chat-page/page-chat.tsx | handleModelChange | 修改 | 已走 updateSession 复合 body（标杆），无逻辑改；仅注释补充「三 chat 统一写 session」 | 不动行为 | req §A2 标杆 | +2/-1 |
| lib_providers | app/web/src/lib/providers.ts | ModelSelection | 修改 | 文档化：已是 `{providerId, modelId}` 复合；findProviderIdByModelId 保留（back-compat 老路径，picker 内部读侧 default 显示仍可能用） | MUST NOT 删 findProviderIdByModelId（渐进） | req §B1 | +3/-0 |
| squad_api | app/web/src/lib/squad-api.ts | CreateSquadBody / PatchSquadBody | 修改 | 加 `modelDefaultProviderId?` / `summaryModelDefaultProviderId?` 字段（透传） | optional | req 段 B | +4/-0 |
| squad_admin_ui | app/web/src/components/studio-page/section-squad-panel.tsx（或 squad 创建表单所在文件，coder 定位） | squad 创建/编辑表单 | 修改 | model 选择器提交时带 providerId（复合）；回显读 record.modelDefaultProviderId | MUST 前端复合对齐后端；coder 定位实际表单文件 | req §B3 | +8/-2 |
| member_admin_ui | app/web/src/components/studio-page/*（member 面板/hire modal，coder 定位） | hire / patch member 表单 | 修改 | 删除 member.model 设置项（hire modal / member 面板 / patch 表单） | MUST 全部 member.model UI 入口移除；MUST NOT 留孤儿 input | req §A4 | +0/-12 |

### 段 E — 前端：两层 base 组件抽象（C 主轴）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| base_chat_page | app/web/src/components/chat-page/base-chat-page.tsx | BaseChatPage | 新增 | page 级 base：主区骨架（topbar 容器 + 消息区 wrapper + input bar slot + area-hooks 装配 + chrome 门控 loading fallback + clear modal）。props：`sessionId / topbar-left slot / topbar-right slot / message-stream slot / input-bar slot / area-hooks 组合 / state-machine flags` | MUST 单文件 ≤300 行；MUST NOT 含 biz 逻辑（store/chromebiz 在消费方注入）；slot 用 children / render-prop | req §C 主轴；page-base 设计见 §3 | +220/-0 |
| base_chat_page | app/web/src/components/chat-page/base-chat-page.tsx | BaseChatPageProps | 新增 | 接口契约：`{ sessionId, loading?, topbarLeft?, topbarRight?, messagesSlot, inputSlot, onClearConfirm?, hideClearBtn? }`；area-hooks 由消费方装配后透传 message 数据进 messagesSlot | MUST slot 覆盖三差异（topbar 源 / input variant / actor+filter） | req §3 | +30/-0 |
| base_chat_input_bar | app/web/src/components/chat-page/base-chat-input-bar.tsx | BaseChatInputBar | 新增 | 组件级 base：input 骨架（ComponentRunStateBar + HITL 卡分流 base + ChatComposer wrapper + 按钮行容器）；props：`sessionId / running / state / pendingToolCall / submitReply / onEnqueueCancel / composerSlot / buttonRowSlot` | MUST ≤300 行；MUST NOT 含 picker 具体类型（picker 走 buttonRowSlot） | req §C1 | +180/-0 |
| base_chat_input_bar | app/web/src/components/chat-page/base-chat-input-bar.tsx | BaseChatInputBarProps | 新增 | 接口：slot 驱动（picker / extra buttons 走 slot；hitl 分流 base 内置 approval+question 两卡） | MUST HITL subState 分流在 base（两卡互斥逻辑共用，C2） | req §C2 | +25/-0 |
| playground_page | app/web/src/components/chat-page/page-chat.tsx | PageChat | 修改 | 重构为 `BaseChatPage` 消费方：topbar-left = conv panel（左栏）+ 标题；topbar-right = UsagePanel+CompactBtn+ClearBtn；messagesSlot = ComponentMessageStream；inputSlot = `<BaseChatInputBar>`（内嵌 InputModelPicker+InputEffortPicker+InputApprovalModePicker + send/abort）；左/右栏 wrapper 保留外部 | MUST 保留三栏布局（conv + chat + workspace）；store biz 保留（useChatStore 装配 area-hooks） | req §3 边界 | +40/-80 |
| studio_member_page | app/web/src/components/studio-page/section-member-chat.tsx | MemberChatPageLoaded | 修改 | 重构为 `BaseChatPage` 消费方：topbar-left = MemberAvatar + tag；topbar-right 同；input slot 用 `<BaseChatInputBar>`（picker = session model，C3）；area-hooks 同（5 个） | MUST chrome 源 = useStudioChatChrome；MUST state machine 同 playground（有 run 态） | req §3 | +30/-70 |
| studio_member_input | app/web/src/components/studio-page/component-member-chat-input-bar.tsx | ComponentMemberChatInputBar | 修改 | 重构为 `BaseChatInputBar` 消费方：picker = InputModelPicker（走 session，段 D）+ InputEffortPicker + InputApprovalModePicker；send/stop 保留 | MUST 走 session（段 D 已落地）| req §C1 §D | +20/-50 |
| studio_squad_page | app/web/src/components/studio-page/section-squad-chat.tsx | SquadChatPageLoaded | 修改 | 重构为 `BaseChatPage` 消费方：topbar-left = squad name+tag；topbar-right 同；input slot = `<BaseChatInputBar>`（picker = per-call override + 无 stop 按钮 + 无 effort/approval picker）；area-hooks = 3 个（messages+usage+fanout，无 run-state） | MUST state machine 关 run 态（hideStopButton=true）；MUST per-call override 保留（不持久化） | req §3 边界 | +30/-60 |
| shared_topbar | app/web/src/components/chat-page/component-chat-topbar-right.tsx | ComponentChatTopbarRight | 新增 | 抽 topbar-right 复合组件（UsagePanel + 分隔符 + CompactBtn + ClearBtn）；props：`usage / summaryTask / sessionBusy / onCompact / onClear`（C2 DRY ~100 行消除） | MUST 三 chat 页共用；MUST NOT 含 biz（按钮 click handler 由消费方注入） | req §C2 | +45/-0 |
| clear_modal_keep | app/web/src/components/chat-page/component-clear-confirm-modal.tsx | (no symbol change) | 修改 | 文档化：三页共用，已是 base 级；BaseChatPage onClearConfirm prop 统一入口 | 不动实现 | C2 | +2/-0 |

### 段 F — spec / 文档同步（doc-modifier 阶段 5 主导，架构期仅记录待改 spec 锚点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec_model_resolve | specs/tech/agent/providers_and_models/[P0]model_resolve.md | §4 原则 3 | 修改 | 改：ModelRef = `{providerId, modelId}` 复合（三持久化字段统一复合）；providerId 缺省 fallback 跨 provider 反查（back-compat） | MUST doc-modifier 阶段同步；原则改动记录到 log.md | req §B1 | +8/-4 |
| spec_model_resolve | specs/tech/agent/providers_and_models/[P0]model_resolve.md | §3 表 6 行 | 修改 | row 5/6 去 `member.model` 步骤；文档说明 member.model 已删 | MUST 表与代码对齐 | req §A3 | +2/-4 |
| spec_session_config_studio | specs/tech/squad/[P1]session_config_studio.md | §3 | 修改 | model/effort/approval 三字段 session 中心化契约；member.model 移除说明 | doc-modifier 同步 | req §0.3 §A1 | +12/-3 |
| spec_data_model | specs/tech/squad/[P1]data_model.md | member / squad 章节 | 修改 | member 去 model 字段；squad 加 modelDefaultProviderId / summaryModelDefaultProviderId | doc-modifier 同步 | req §A4 §B3 | +6/-4 |
| spec_api_squad | specs/api/overall/11-squad.md | §4.5 (squad body schema) + member body schema | 修改 | squad body 加复合 providerId 字段；member body 去 model | doc-modifier 同步 | req §B §C | +6/-3 |
| spec_ui_picker | specs/ui/components/chat-page/component-input-model-picker.md | §11 | 修改 | 新增 defaultModelProviderId prop 契约；复合默认态显示规则 | doc-modifier 同步 | req §D | +6/-0 |
| spec_ui_base | specs/ui/components/chat-page/base-chat-page.md | (new spec) | 新增 | BaseChatPage 契约（slot 接口 + 三消费方差异矩阵）；coder 编码前置产出 | doc-modifier 同步 | req §E §3 | +80/-0 |
| spec_ui_base_input | specs/ui/components/chat-page/base-chat-input-bar.md | (new spec) | 新增 | BaseChatInputBar 契约（slot + HITL 分流 + picker slot） | coder 编码前置产出 | req §E §3 | +60/-0 |

---

## 2. 不变量清单（reviewer 查偏离）

### 后端 invariants
- **INV-A1** resolver chat 链不读 member.model：`buildFallbackChain` studio leader/mate 分支不再 push `member?.model`。任何 reintroduce member.model 到 resolveModel 链 → 违反。
- **INV-A2** session 是 model/effort/approval 的**唯一运行配置读源**：`buildSessionConfigFromDeps` 读 sessionPersist 四字段（已就绪，本版本只强化）；`resolveModel` 只接 session+squad 上下文（member 出参数列表）。
- **INV-A3** `effort / approvalMode` 读路径保持纯 session-only（本版本不动）——`session.effort → config.effort`、`session.approvalMode → config.approvalMode → engine.ts:196`，禁任何 member 绕行。
- **INV-A4** member record 写入点永不再接受 / 落盘 `model` 字段（schema/service/handler/team-tool 全去）。
- **INV-A5（default 来源不混）** default 来源由 `resolveDefaultModel(input, task)` 单点决策：playground 仅读 `app_config.default_models.{chat\|summary}`，studio 仅读 `squad.modelDefault`（chat）或 `squad.summaryModelDefault ?? squad.modelDefault`（summary）。**MUST NOT 跨来源**（playground 读 squad / studio 读 app_config）；**MUST NOT 给 studio 加 app_config fallback**（squad.modelDefault 必填保持；squad 未配 → fallback 链跑空 → throw ModelNotConfiguredError，语义与 v0.0.89 起一致）；reviewer 查 buildFallbackChain 内不得再 inline `readPlaygroundDefault` / 直读 `squad?.modelDefault`，必须经 resolveDefaultModel 单点。
- **INV-B1** ModelRef 复合：三持久化字段（session.modelId+providerId / squad.modelDefault+modelDefaultProviderId / summaryModelDefault+summaryModelDefaultProviderId）统一 `{providerId?, modelId}` 结构；providerId optional for back-compat。
- **INV-B2** resolve 精确：providerIdHint 已知 → 必须精确匹配该 provider；providerIdHint 空 → 跨 provider 反查（救存量）。两条路径都走 `findProviderForModel(svc, modelId, hint?)` 单点出口。
- **INV-B3** back-compat：所有新 providerId 字段 optional；缺省 fallback 旧路径（跨 provider 反查）；现存数据无需 migration。
- **INV-C1** `validateModelId` / `checkModel` 双路签名：`(svc, modelId, providerIdHint?)` — hint 空 → 旧跨 provider 行为；hint 非空 → 精确。

### 前端 invariants
- **INV-D1** 三 chat 页 picker 全走 session/per-call：playground=`updateSession` 复合 / studio member=`updateSession` 复合（新） / studio squad=`postMessage` per-call body（已对）。**禁任何 picker 再调 patchMember 改 model**。
- **INV-D2** ModelSelection 类型保持 `{providerId, modelId}` 复合（已是）；picker onChange 输出复合；消费方写 body 透传复合。
- **INV-E1** BaseChatPage 只含骨架（topbar/messages-wrapper/input/clear-modal）；biz 逻辑（store dispatch / chrome fetch / state machine / area-hooks 装配）由消费方注入。
- **INV-E2** BaseChatInputBar 只含骨架（composer wrapper + button row + HITL 分流）；picker 与 extra buttons 走 slot。
- **INV-E3** 群聊状态机关：`hideStopButton=true / hideRunStateHooks=true`（input 用 base 但 slot 关停止 + 不挂 useRunState）。
- **INV-E4** topbar-right DRY：三页共用 `<ComponentChatTopbarRight>`（C2，~100 行 DRY）。

---

## 3. page 级 base 边界设计（对应 C 主轴 + 用户「评估边界诚实」要求）

### 3.1 BaseChatPage props / hooks / slot 接口（草案）

```typescript
interface BaseChatPageProps {
  sessionId: string;
  loading?: boolean;                    // chrome / sessions 初始 loading（门控占位）
  // topbar slot（左：title/avatar；右：usage/compact/clear 三件套）
  topbarLeft?: React.ReactNode;         // playground=空（左有 conv-panel）/ studio=avatar+tag
  topbarRight?: React.ReactNode;        // 默认 = <ComponentChatTopbarRight {...} />（C2）
  // 主区 slot
  messagesSlot: React.ReactNode;        // ComponentMessageStream + empty fallback（消费方装配 area-hook 数据）
  inputSlot: React.ReactNode;           // <BaseChatInputBar> 或群聊自定义
  rightOverlaySlot?: React.ReactNode;   // ComponentChatRightOverlay（三页都用）
  // clear 行为（三页同形）
  onClear?: () => void;
  clearModalOpen?: boolean;
  onClearModalChange?: (open: boolean) => void;
  // testid（三页 testid 不同：chat-page / squad-chat-page）
  rootTestid?: string;                  // 缺省 'chat-page'
}
```

### 3.2 进 base（共用度 ~90%）

- 主区 `<main>` 容器 + flex 骨架（topbar / messages wrapper / input bar 垂直排）
- topbar 容器（border-b + shrink-0 + 右侧 ml-auto）
- messages wrapper（flex-1 + relative + overflow-hidden，right-overlay 定位上下文）
- clear modal 挂载（ComponentClearConfirmModal，三页同款）
- chrome loading 占位（chat-loading testid，studio 用）
- fadeIn 动画 wrapper

### 3.3 保留独立（差异大 / 强行业 biz，不强行塞 base）

- **store biz 分流**（playground `useChatStore` vs studio `useStudioChatChrome`）— 走 props 透传已装配的 messages/runState 数据；base 不持 store
- **chrome 数据源**（playground 多个 area-hook 拼 / studio `useStudioChatChrome` 单点）— 消费方装配 area-hooks 后 results 透传 messagesSlot
- **状态机开关**（群聊无 run 态）— 用 `hideStopButton` flag（input slot 内部消费）+ 消费方决定挂哪些 area-hook（群聊不挂 useRunState/useSummary）
- **左/右栏 slot**（playground 三栏 conv+chat+workspace / studio chat 单栏 + 右 tabs）— base 只管 chat 主区；外部 layout 消费方包
- **model 持久化回调**（session vs per-call）— picker 走 input slot 内部，base 不感知
- **actor / filter / sideResolver**（群聊 `groupMessageFilter` / 单聊 `memberSideResolver` / playground 默认）— 透传到 messagesSlot 内的 ComponentMessageStream，base 不介入
- **prefill / onOpenMember**（studio 特有）— 消费方局部 state，slot 透传

### 3.4 BaseChatInputBar 边界

**进 base**：ComponentRunStateBar 挂载位置 + HITL 卡 subState 分流（need_approval/need_feedback 两卡互斥）+ ChatComposer 容器（textarea 上 / 按钮行 下）+ 错误行渲染

**保留独立（slot）**：按钮行 picker 组合（playground/member = model+effort+approval / squad = model only）+ send/stop 按钮（squad 无 stop）

---

## 4. 数据迁移方案

### 4.1 session（无 migration）
- `providerId? / modelId? / effort? / approvalMode?` 早已就绪（v0.0.9 / v0.0.148）；现存量 session 直接受益，无 schema 改动。

### 4.2 squad.modelDefault / summaryModelDefault（back-compat，无强制 migration）
- 新增 optional `modelDefaultProviderId` / `summaryModelDefaultProviderId` 字段。
- **读侧**：resolver 候选 modelId 时，若配套 providerIdHint 存在 → 精确匹配；缺省 → 跨 provider 反查（旧路径，救存量）。
- **写侧**：新建 / PATCH squad 时，若 UI 传复合 → 落盘复合；若 UI 旧版传纯 modelId → 仍接受（back-compat 校验走旧路径）。
- **不跑批量 migration**（lazy 升级，用户下次编辑 squad 时自然补齐 providerId）。

### 4.3 member.model（硬删，读侧忽略）
- `member.model` 字段从 schema/service/handler/team-tool 全去。
- **存量 record.model**：读侧 resolver 已不读（A3），忽略不报错；写侧永不再落盘。
- **无 migration 脚本**（字段自然 dead；用户感知 = squad admin UI 不再有 member.model 设置项）。
- **风险**：用户依赖 member.model 做「per-member 模型偏好」→ **破坏性变更**。需用户确认（本变更符合用户硬指令「member 退管理概念」）。

### 4.4 v0.0.154 处置
- **不 revert v0.0.154**（D1）：v0.0.154 改的「member.model 纯 modelId PATCH」路径在 A2 后自然失效（picker 不再 patchMember）。
- v0.0.154 修的表层 bug（400 被吞）在 A2 后路径不再走，自动消失。

---

## 5. 影响面评估

### 跨模块
- **后端**：model-resolver / model-validation / session-config / bootstrap / member-service / member handler / squad handler / squad-service / squad schema / member schema / team-write-actions
- **前端**：三 chat 页 + 三 input bar + chrome hook + picker + topbar-right DRY + squad-types + chat-api / squad-api 客户端 + squad admin 表单 + member 面板/hire modal
- **spec**：[P0]model_resolve / [P1]session_config_studio / [P1]data_model / 11-squad / component-input-model-picker / 新增 base-chat-page + base-chat-input-bar 组件 spec

### 破坏性变更
1. **member.model 硬删**（后端 API + 前端 UI + team hire tool）— 最重破坏点；存量数据忽略不报错但 UI/API 契约变。
2. **squad record 加两 optional 字段** — 非破坏（optional），旧 client 不受影响。
3. **resolveModel input shape 变**（`member` 字段移除）— internal API 变更，无外部 HTTP 影响。

### 依赖顺序
1. **后端 schema 先**：squad/member schema 改 → handlers/services 适配 → resolveModel 链改 → validateModelId 改
2. **前端 picker 改 chrome 读源**：依赖后端 GET /session 响应含 modelId/providerId（早已就绪）
3. **前端 base 抽象独立可并行**：与后端改无依赖（消费 slot 抽象 + 数据 prop 透传）

---

## 6. 风险点

### R1 [高] member.model 硬删 = 破坏性
- **风险**：用户或 squad admin UI 依赖 member 级模型偏好；team hire 工具 schema 改变影响 LLM 行为。
- **缓解**：架构期已在 §0.1 落实决策依据（用户硬指令）；task-board 记 known-issue；AT 验「hire member 无 model 字段」+「PATCH member body.model 被忽略 + warn」。

### R2 [中] ModelRef 复合 back-compat fallback 误命中同名 model
- **风险**：旧 squad / session 无 providerId → 跨 provider 反查 → 若多 provider 同名 modelId 仍歧义（B1 的根因未完全解决，仅对新数据解决）。
- **缓解**：doc-modifier 阶段文档化「渐进迁移期」；AT 测「同名 model 跨 provider + 复合精确命中」；coder 在 picker UI 显式提示用户选复合（减少存量歧义）。

### R3 [中] BaseChatPage 抽象过度 / slot 泛滥
- **风险**：三页差异通过过多 slot 注入 → base 变「slot 容器」而非真共用；或抽象破坏某页特有交互。
- **缓解**：§3 边界明确「进 base vs 保留独立」；coder 先抽 BaseChatInputBar（输入区共用度高）→ 再抽 BaseChatPage；每抽一层三页都跑回归。若发现 slot 数 >5 → 退一步保留独立。

### R4 [中] resolver 链改后 summary 链漏改
- **风险**：A3 同时改 chat 链（row 5）+ summary 链（row 6），若 summary 漏改 → compact 时 member.model 仍被读（违反 INV-A1）。
- **缓解**：UT 覆盖 row 5 chat + row 6 summary 两链都不读 member.model；reviewer 按 INV-A1 逐链查。

### R5 [低] studio member-chat data source migration
- **风险**：studio member-chat picker 旧走 patchMember（写 member），新走 updateSession（写 session）→ 用户已存的 member.model 值不再生效。
- **缓解**：member.model 存量值本就常被 session.modelId 压住（v0.0.154 根因），迁移后用户首次 picker 操作即落 session；无数据丢失（member.model dead 不等于 session 无值，fallback 走 squad.modelDefault）。

### R6 [低] picker defaultModelId 字符串 back-compat
- **风险**：squad 旧数据 modelDefault=纯 string；新 UI 传复合 → squad record.modelDefault 字段仍落 string，providerId 单独字段；picker 读侧 `defaultModelId` string + `defaultModelProviderId` optional 双兼容。
- **缓解**：picker Props `defaultModelProviderId?` optional；缺省走旧反查；coder 实现保留两条路径（已在段 D 注释）。

---

## 7. 任务拆分建议（planner 参考用，不强制）

按「后端底层 → 后端 API → 前端 data → 前端 UI base → spec」垂直切，建议 **5 task**（3-8 范围内）：

| Task | 范围 | coversModules / Files |
|------|------|------|
| T1 后端 resolve 重构（A + B 核心）| resolveModel / model-resolver.ts / model-validation.ts / session-config.ts / bootstrap.ts | 段 A + 段 B 的 model_resolver/model_validation（不含 squad schema）|
| T2 后端 squad/member schema + handler（A4 + B3）| schema_defs/squad/squad.ts / member.ts / squad.ts(handler) / member.ts(handler) / member-service.ts / team-write-actions.ts / squad-service.ts | 段 B 的 squad_schema/squad_handler/squad_service + 段 C 全 |
| T3 前端 picker + chrome session 中心化（D）| component-member-chat-input-bar.tsx / use-studio-chat-chrome.ts / section-squad-chat.tsx (picker part) / squad-types.ts / squad-api.ts / providers.ts / squad admin UI / member admin UI | 段 D 全（除 page-chat 标杆注释行）|
| T4 前端两层 base 抽象（E）| base-chat-page.tsx (new) / base-chat-input-bar.tsx (new) / component-chat-topbar-right.tsx (new) / page-chat.tsx refactor / section-member-chat.tsx refactor / section-squad-chat.tsx refactor / component-member-chat-input-bar.tsx refactor | 段 E 全 |
| T5 spec 文档（F，doc-modifier 主导）| specs/tech / specs/api / specs/ui | 段 F 全 |

**依赖**：T1 → T2 → T3（后端先于前端）；T4 可与 T3 并行（base 抽象不依赖 picker 改，只依赖数据 prop 契约）；T5 最后（doc-modifier 阶段 5）。

**测试**：每 task 自带 UT（后端 resolve 链 / schema 校验 / 前端 chrome hook / base 渲染）；AT/ET 在验证阶段跑冒烟集（不需新增 case，本版本是重构，LLM 路径不变，冒烟集 + UT 即覆盖；唯一可能新增 AT =「PATCH member body.model 被忽略 + warn」若需要明确契约，由 api-test-designer 评估）。

---

## 8. 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- member.model 删除 / BaseChatPage 边界调整等核心决策偏离 → 立即报 architect 重新确认（非 coder 自由裁量范围）
