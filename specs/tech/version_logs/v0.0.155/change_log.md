# v0.0.155 tech change_log — chat 模型配置 session 中心化 + ModelRef 复合 + 两层 base

> 跨版本发布说明（版本轴）。位置轴见各 KB `log.md`（`providers_and_models/log.md` + `squad/log.md`）。
> 变更契约（method 级 review 合同）：本目录 `change_plan.md`（段 A-F + INV-A1~A5/B1~B3/C1/D1~D2/E1~E4）。

## 核心主轴（三统一）

1. **session 统一接口**：model/effort/approval 走同一 session config 接口（`PUT /session/:id` body 复合 `{providerId?, modelId?, effort?, approvalMode?}`），不再 patchMember 改 model（INV-D1）。
2. **统一 UI 组件**：抽 base chat input + base chat page，playground + studio 单聊共用（squad 群聊独立 per-call、无 run 态）。
3. **统一后端服务**：model resolve/validation 统一一套（providerId+modelId 精确定位），不分 member/session 两套。

## 后端变更（段 A-C）

### A. resolveModel 链重构（核心）

- **`ResolveModelInput` 去 member**（INV-A2）：删 `member?: { model?: string }`；加 `sessionProviderId` / `bodyOverrideProviderId`（作 sessionModelId/bodyOverride 精确 hint）；`squad` 子集加 `modelDefaultProviderId` / `summaryModelDefaultProviderId` 复合字段。
- **`buildFallbackChain` 简化 4 核心链**（INV-A1）：原 6 行含 `member.model` 步骤；v0.0.155 后 leader/mate/squad 走相同链（bodyOverride → session → resolveDefaultModel → squad）。
- **`resolveDefaultModel` 新增**（INV-A5 单点出口，用户裁决 2026-07-16 方案 2）：消除原 buildFallbackChain 内散乱 default 分支（`readPlaygroundDefault` vs 直读 `squad?.modelDefault`），统一按 sessionType 分发：playground → `app_config.default_models`；studio → `squad.{summary,}modelDefault`。**MUST NOT 跨来源**；**MUST NOT 给 studio 加 app_config fallback**。
- **`findProviderForModel` 双路**（INV-B2）：签名加 `providerIdHint?: string`——hint 非空 → 精确匹配该 provider（消除同名 modelId 歧义）；hint 空 → 跨 provider 反查（back-compat 救存量）。
- **`ResolvedModel` 复合文档化**：输出 `{providerId, modelId}` 为权威复合 ModelRef（hint 命中则 = 输入 hint；hint 空 = 跨 provider 反查命中的首个）。

### B. ModelRef 复合（squad schema）

- **`SquadSchema` 加两字段**：`modelDefaultProviderId?: string` + `summaryModelDefaultProviderId?: string`（与 `modelDefault` / `summaryModelDefault` 配对作复合 ModelRef；optional back-compat，INV-B3）。
- **`handlers/squad.ts`**：`CreateSquadBody` / `PatchSquadBody` 加复合字段；`checkModel(svc, modelId, providerIdHint?)` 双路签名（INV-C1）；`toSquadSummary` / `toSquadDetail` 回显字段；校验：providerId 非空但 modelDefault 空 → 400 `providerId without modelDefault`。
- **`services/model-validation.ts`**：`validateModelId(svc, modelId, providerIdHint?)` 双路签名（与 checkModel 同款）。

### C. member.model 硬删（A4 决策）

- **`schema_defs/squad/member.ts`**：`model` 字段从 schema 完全移除（不保留 dead，原则「不遗留死代码」）。
- **`services/member-service.ts`**：删 `model: ov.model ?? parent.model` 派生；删 `validateModelId` 调用；`MemberCreateInput` 去掉 model 字段；`resolveEffective` 不再处理 model。
- **`handlers/member.ts`**：`handleHire` 删 `body.model` 入参 + validateModelId；`handlePatchMember` 删 `body.model` 分支；旧 client 传 model → warn+ignore（back-compat，不 400）。
- **`agent/tools/team-write-actions.ts`**：hire schema 去 `model: {type:'string',...}`；`HireMemberAction` input type 去 `model?`；`runEdit` patch 去 model。
- **`member-mutations.ts`**：`MemberMutationDeps` 移除 `appConfig?`（原 patchMember 校验 model 用，A4 删 model 后变 dead）；3 个 caller（`handlers/member.ts` + `team-write-actions.ts`）同步不再传 appConfig。

## 前端变更（段 D-E）

### D. picker session 中心化（写链路）

- **`component-member-chat-input-bar.tsx`**：`handleModelChange` 从 `patchMember(squadId, memberId, {model})` → `updateSession(sessionId, {providerId, modelId})` 复合 body（INV-D1，与 playground 同款）；`memberModelSel` 读源从 `member.model` 改为 `chrome.sessionModel`（chrome 扩展）；移除 `findProviderIdByModelId` 反查（复合直接读）。
- **`use-studio-chat-chrome.ts`**：加 `sessionModel?: { providerId?: string; modelId?: string }`（从 GET /session 响应读）+ `setModel` 命令式 setter（乐观本地 + PUT fire-and-forget，与 setEffort 同款）；`onInit` 多取 `s.providerId/s.modelId`（不新增网络请求）。
- **`component-input-model-picker.tsx`**：新增 `defaultModelProviderId?: string` prop——优先精确命中（消除同名歧义）；命中失败 fallback 走 `findProviderIdByModelId` 跨 provider 反查。
- **squad admin UI**（new-squad-modal/manage-tab）：提交带 providerId（复合）；hire modal 删 member.model 选择器（A4 对齐）。
- **`squad-types.ts`**：`SquadDetail` 加 `modelDefaultProviderId?` + `summaryModelDefaultProviderId?`。

### E. 两层 base 组件抽象

- **`base-chat-page.tsx`**（新增，146 行）：page 级骨架（topbar/messages wrapper/input slot/clear modal/loading 占位/fadeIn）。INV-E1 纯骨架（store biz 在消费方注入）。
- **`base-chat-input-bar.tsx`**（新增，133 行）：input 级骨架（composer wrapper + button row + HITL subState 分流两卡互斥）。INV-E2 slot 驱动。
- **`component-chat-topbar-right.tsx`**（新增，58 行）：topbar 右侧复合（UsagePanel + 分隔符 + CompactBtn + ClearBtn）。INV-E4 DRY 三页共用。
- **三页 refactor**：`section-squad-chat.tsx` (312→249) / `section-member-chat.tsx` (267→238) / `component-member-chat-input-bar.tsx` (224→188) 全部消费 BaseChatPage + BaseChatInputBar + ComponentChatTopbarRight。**playground section-chat-detail.tsx 未重构**（413 行超限但 pre-existing；change_plan 表 target 是 page-chat.tsx 外层而非 section-chat-detail，测试覆盖密集 5+ 文件，重构风险高）。

## 不变量（INV）落实自查

| INV | 自查 |
|---|---|
| INV-A1（resolver 链不读 member.model） | ✅ grep `member.model` / `member\?\.model` 在 model-resolver.ts 零（除注释） |
| INV-A2（session 唯一运行配置读源） | ✅ buildSessionConfigFromDeps 不构 member 子集传 resolve |
| INV-A3（effort/approval 读路径零改） | ✅ 纯 session-only 链路（v0.0.148 已就绪） |
| INV-A4（member record 永不再写 model） | ✅ schema/service/handler/team-tool 全去 |
| INV-A5（resolveDefaultModel 单点出口） | ✅ grep 唯一定义；buildFallbackChain 内无 inline default 分支 |
| INV-B1（ModelRef 复合） | ✅ 三持久化字段统一 `{providerId?, modelId}` 结构 |
| INV-B2（resolve 精确） | ✅ hint 非空 → 精确匹配；hint 空 → 跨 provider 反查；都走 findProviderForModel 单点 |
| INV-B3（back-compat） | ✅ 新 providerId 字段全 optional；缺省 fallback 旧路径 |
| INV-C1（validateModelId/checkModel 双路） | ✅ 双路签名 `(svc, modelId, providerIdHint?)` |
| INV-D1（三 picker 全走 session/per-call） | ✅ grep patchMember 在 picker 调用方零 |
| INV-D2（ModelSelection 复合保持） | ✅ `{providerId, modelId}` 输出形状不变 |
| INV-E1（BaseChatPage 纯骨架） | ✅ 只含 topbar/messages/input/clear-modal；biz 在 props/slot |
| INV-E2（BaseChatInputBar slot 驱动） | ✅ picker/extra buttons 走 slot；HITL 分流内置 |
| INV-E3（群聊状态机关） | ✅ hideStopButton=true + 不挂 useRunState/useSummary |
| INV-E4（topbar-right DRY） | ✅ 三页共用 ComponentChatTopbarRight |

## coder 偏离汇报

1. **MemberMutationDeps 移除 `appConfig?`**：原为 patchMemberService 校验 model 用，A4 删 model 后变 dead；同步更新 3 个 caller（handlers/member.ts + team-write-actions.ts）。change_plan 段 C 未明列 member-mutations.ts，但 PatchMemberInput 有 model 必删以保持类型绿——属必要适配，非核心约束偏离。
2. **squad-service.createSquadService 加 summaryModelDefaultProviderId 清空逻辑**：在 summaryModelDefault 空串时也清空 summaryModelDefaultProviderId（防孤儿 providerId），handler 层对应 checkModel 加 modelId-without-providerId 校验。语义扩展但符合 INV-B1/B3。
3. **playground section-chat-detail.tsx 未重构为 BaseChatPage 消费方**：pre-existing 413 行；change_plan 表 target 是 page-chat.tsx 外层而非 section-chat-detail；测试密集风险高，留待后续。不影响段 D 中心化收益（playground picker 早已走 updateSession 标杆）。
4. **hire modal 删 model 选择器后改用 i18n key `studio:hireModal.freshModelHint`**：i18n value 待补（否则显 key 字面），需 i18n 资源更新（未在本 task 范围）。

## 影响面（跨模块）

- **后端**：model-resolver / model-validation / session-config / bootstrap / member-service / member handler / squad handler / squad-service / squad schema / member schema / team-write-actions / member-mutations
- **前端**：三 chat 页 + 三 input bar + chrome hook + picker + topbar-right DRY + squad-types + chat-api / squad-api 客户端 + squad admin 表单 + member 面板/hire modal
- **spec**：[P0]model_resolve / [P1]session_config_studio / [P1]data_model / 11-squad / component-input-model-picker / 新增 base-chat-page + base-chat-input-bar 组件 spec
