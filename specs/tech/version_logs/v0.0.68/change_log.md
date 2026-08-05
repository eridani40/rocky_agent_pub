# v0.0.68 Tech Change Log — 看板一等公民 + 对话 @mention 扩展 + 工具默认值 + squad chat 修复

> version: 1.0 · 2026-07-05
> 一句话：把看板从「让 leader 在对话里建」反转为「看板上手新建」的一等公民工具；对话侧扩 @workitem/@member（按 session kind 启用不同 provider 集合，D8 resolver 抽象）；看板 @按钮一键带回 leader 对话预填；通用化工具参数 default-fill（首个消费者 send_message needReply=true）；修 squad chat model 展示 bug + LLM 错误没进 langfuse 两件 bug。
> 设计权威：本文件（设计叙事）+ `change_plan.md`（method 级 8 列契约）+ `specs/tech/mention/resolver.md`（D8 概念落 spec）+ `specs/tech/mention/provider-interface.md §3/§7/§8`（WorkItem/MemberProvider 概念落 spec）

---

## 1. 背景

v0.0.60 让看板可编辑（POST/PATCH/archive/restore 全上），但前端只接了 edit——empty-state 文案「让 leader 在对话中创建」把**写操作让渡给对话**：用户得离开看板、去群聊/单聊让 leader 调 LLM 工具才能新建 workitem。这违背「看板是 CRUD 工具」的用户预期，也让 AI 显得多管闲事。

对话侧 @mention 系统（v0.0.45）只有 file+skill 两个 provider，无法把 workitem/member 当一等引用对象塞进对话——用户在对话里讨论某个 goal/task 时无法精确指向它。

加两个已暴露 bug：squad chat 一直显示「请选择 model」（modelOverride 不播种 + 不传 inheritLabel）+ LLM 错误没进 langfuse（llm_caller invoke() 外层 catch 只写 dev log 就 rethrow，违反 spec `llm_caller.md §2.1 line 65` 不变量）。

## 2. 范围（7 需求 R1-R7 + D8 抽象）

详见 PRD `specs/prd/version_logs/v0.0.68.md` §2.1（IN-SCOPE 表）。本 change_log 聚焦**设计决策 + 实现要点**，不复述 PRD。

## 3. 核心设计

### 3.1 看板一等公民（R1）

**复用而非新建**：edit-panel 已是全字段表单（component-board-edit-panel.tsx:75-122），加 `mode:'create'|'edit'` 即可。`mode='create'` 时 initial snapshot = 字段 default 而非 findEntity；保存分支调 POST（create）而非 PATCH（edit）。

**API 零变更**：POST /goals|goals/:gid/krs|requirements|tasks 在 v0.0.60 已存在（spec `11b-squad-workitems.md §3`），前端 web api client `squad-api-board.ts` 缺 create helpers——本版本只补 web 侧。

**Task→Requirement 约束（D1-b）**：表单强制先选父 Requirement 才能保存（保存按钮 disabled until source 非空）。

**文件体量护栏**：`component-board-edit-panel.tsx` 现 281 行，加 mode 分支必超 300 行硬限——拆 form state + handleSubmit 到 `use-board-edit-form.ts` hook（mode 无关），panel 仅渲染。`component-squad-board.tsx` 290 行同理——把「+新建」按钮入口 + empty-state CTA 拆到各 view（goals-view/requirements-view/tasks-view），SquadBoard 透传 `onCreate(kind, parentGoalId?)` 回调。

### 3.2 对话 @mention 扩展（R2/R4 + D8）

**新概念先落 spec**：
- `specs/tech/mention/resolver.md`（新建）：D8 `resolveMentionProviders(sessionKind) → ProviderName[]` 单一映射表
- `specs/tech/mention/provider-interface.md §3/§7/§8`：MentionItem.type 扩开放枚举；WorkItemProvider / MemberProvider 实现要点

**WorkItemProvider**（R2）：消费 `BoardStore.getBoard(squadId, 'all', 'active')` 全集，title 模糊匹配；path=`workitem/<kind>/<id>` 单类型（D2 不拆 4 type）。仅活跃区参与搜索（归档项不入结果）。

> **[doc-sync T2 偏离]** 架构期写的 `BoardStore.getBoard(...)` 是概念表达——该方法不存在。代码实际（`app/server/src/mention/providers/workitem-provider.ts`）：`boardStore.listGoals/listRequirements/listTasks(squadId)` 三次拉全集合视图层调 `buildAncestorView({goals,requirements,tasks})` 构联合检查索引，归档过滤走 `effectiveArchived(...)`。spec 已对齐到代码实际 API（详见 `specs/tech/mention/provider-interface.md §7` + `specs/tech/mention/log.md` v0.0.68 条目）。

**MemberProvider**（R4）：消费 `SquadStore.getSquad(squadId).members`，name 模糊匹配；path=memberId（D4：人可读 ID，不嵌 name——name 易变）。仅 @member 一等引用，不暴露 subagent。

> **[doc-sync T2 偏离]** 架构期写的 `SquadStore.getSquad(squadId).members` 是概念表达——squad record 仅存 `memberIds[]`，member 实体在 `members/` 子目录分片存储。代码实际：`memberStore.listMembers(squadId)` + 过滤 `state==='deployed'`。`MemberSchema.role` 枚举 `['leader','mate']`——天然不含 subagent。spec 已对齐（详见 `provider-interface.md §8`）。

**Resolver 双侧共用**：放 `app/shared/mention-resolver.ts`（前后端共用，shared 包无 React/runtime 依赖）。client 派生 popover tab 列表，server handler 搜索前校验 provider ∈ 允许集合（未授权试探返 404，对齐 `resolver.md §6` + `search-service.ts` 的 `ProviderNotFoundError → 404`）。

**mention 子系统不变量**（task.json invariants）：`<mention type path/>` 自闭合标签端到端零转换不变；新 provider 复用既有 registry/encoding/pill——message-content.md schema 零变更（type 是开放 string）。

### 3.3 看板 @按钮 → leader 对话预填（R3）

**回路链路**（单向 board→chat）：
```
component-board-task-card.tsx (@ 按钮 onClick)
  → component-board-{goals,requirements,tasks}-view (onAtMention 透传)
  → component-squad-board.tsx (onAtMention)
  → component-studio-board-route.tsx (onAtMention)
  → page-studio.tsx (onOpenChatWithMention → setMainView({kind:'chat', node: leaderChatNode, prefill}))
  → component-studio-chat-router.tsx (prefill 透传)
  → section-{squad,member}-chat.tsx (prefill 透传给 ChatComposer)
  → component-chat-composer.tsx (initialContent 受控)
```

**ChatComposer 接口扩展**：
- `initialContent?: MentionAttrs[]`（受控初始化内容，组件 mount 时一次注入 pill）

**leader 解析**：复用既有 `detail.members.find(m => m.role === 'leader').sessionId` 找 ChatNode（已存在的模式）。

**MainView 类型扩展**：`{kind:'chat'; node: ChatNode; prefill?: MentionAttrs[]}`——prefill 是 chat variant 的可选载荷。

### 3.4 工具参数 default-fill（R5）

**D5 通用机制**：放 `validateInput` 末尾（所有工具受益），非各 tool.run 前各自填。

```typescript
// tools/engine.ts validateInput 末尾
if (schema.properties) {
  for (const [key, sub] of Object.entries(schema.properties)) {
    if (obj[key] === undefined && sub.default !== undefined) {
      obj[key] = sub.default;
    }
  }
}
```

**首个消费者 send_message needReply=true default**：
- `required` 数组移出 `'needReply'`（line 32）
- schema properties.needReply 加 `default: true`（line 51-54）
- normalize 容错链路（line 279-286）改 `needReply ?? true`（缺省视为 true，符合 spec 「通常需回复」语义）

**spec 同步（doc-modifier 阶段 5）**：`subagent_derivation.md §5` + `a2a_protocol.md §4.2` needReply 从「★ 必填」改可选 default:true；`agent_tools.md` 补 validateInput default-fill 通用机制。

### 3.5 squad chat model 展示 bug（R6）

**根因**：`section-squad-chat.tsx:55` `modelOverride` 初始为 `null`（不播种）+ line 141 ModelPicker 不传 inheritLabel/onInherit → 占位符常显「请选择 model」。

**修法照搬 member chat**（section-member-chat.tsx:155-160）：
- 父路由 `component-studio-chat-router.tsx:42,49` 透传 `detail.modelDefault`（ModelRef string）给 SquadChatPage
- SquadChatPage `modelOverride` 初值派生自 `squad.modelDefault`（拆 {providerId, modelId}）
- ModelPicker 接 inheritLabel（`'继承小队默认'`）+ onInherit（清 modelOverride 回派生态）

**不变 per-call override 语义**：squad chat ModelPicker 切换仍只改前端 modelOverride state + 塞进 postMessage body，**不**调任何持久化 API（不改 squad.modelDefault）——沿用 v0.0.63 F4b 模式。

### 3.6 LLM 错误进 langfuse（R7）

**违反的不变量**（spec `llm_caller/[P0]llm_caller.md §2.1 line 65`）：「所有 throw 前调 observability.endGeneration({status:'error'})」

**bug 定位**：`llm_caller.ts invoke()` 外层 catch（line 155-161）只写 dev log 后 rethrow，**未调 endGenerationError**。invokeCore 内部各 throw 点（line 269/295/338/346/400）已正确调用，但 invokeCore 抛出的非 ClassifiedLlmError 异常（attemptLoop runtime error 等）会绕过那些点直击外层 catch。

**修法**（避免重复 end）：
- invokeCore 内部已 end 的 throw 都是 ClassifiedLlmError（带 category 字段）
- 外层 catch 判定：若 `e` 不是 ClassifiedLlmError（或没有 endGeneration 已调标记），补 `ctx.observability?.endGenerationError?.(LlmErrorCategory.INTERNAL, msg, { retryChain: [] })`
- 加 `observabilityEnded: boolean` 标志位（外层 catch 检查它而非类型 sniff，更鲁棒）

**endTrace trace-level ERROR**（D7）：`agent-loop-observability.ts endTrace` 当前不接 error 状态——run 失败时（agent loop run.error）需把 trace 标 ERROR。架构上**不变 endTrace 签名**（避免破坏现有调用），加 `markTraceError(reason)` 方法：在 run.error 时调，内部走 `adapter.setLevel(traceHandle, 'ERROR')`；endTrace 不变（仍正常收尾）。

**BUG-001 修复（trace metadata.errorLevel 等价机制）**：spec 起草时写「trace level=ERROR 落盘」，实际 langfuse `ApiTraceBody` schema **无 level 字段**（仅 observation 有），SDK `trace.update({level})` 被后端 silently 忽略 → AT trace_level=None fail。修走 spec R7 change_plan 行 101「或等价机制」：`LangfuseAdapter.setLevel` 按 handle.kind 分支——trace 类型改 `metadata.errorLevel=ERROR`（deep-merge 不覆盖原字段，可被 GET /traces/{id} 查询）；span/generation 不变（observation schema 支持 level）。commit 03c1b9a8 + 决策 bbb1d339。**关键**：trace 顶层**没有** level 字段，必须走 `metadata.errorLevel` 等价表达。

## 4. 决策记录（D1-D8）

详见 task.json `decisions`。架构层补充：

| 决策 | 理由 |
|---|---|
| `use-board-edit-form.ts` hook 拆分（不另建 CreatePanel 组件） | edit/create 共用字段集合，差异仅在 initial snapshot + 保存分支；hook 化保 ≤300 行硬限 + 单一字段定义源 |
| `+新建`按钮入口下放到各 view（不上提到 SquadBoard 顶部） | 各 view 知道自己的 entity kind；SquadBoard 只透传 `onCreate(kind, parentGoalId?)` 回调；保 SquadBoard ≤300 行 |
| ChatComposer 加 `initialContent` 受控注入 | initialContent=mount 时受控注入（prefill 场景）；无 UC 需要命令式 ref API（YAGNI，减少 common 文件扰动） |
| D8 resolver 放 `app/shared/`（非 `app/server/src/mention/`） | client 也要消费，必须 shared；放 mention 子系统内部会让 client 反向依赖 server 包 |
| endTrace 不变签名 + 加 markTraceError | 破坏 endTrace 签名会触发 4+ 调用点修改 + 测试；markTraceError 仅在 run.error 路径调，影响面可控 |

## 5. 文件级变更清单（按需求分组）

> method 级行项见 `change_plan.md`（8 列契约表）。本节是设计粒度的文件级叙事，两者数据一致。

### R1 看板手动新建
| 文件 | 操作 | 变更 |
|---|---|---|
| `app/web/src/lib/squad-api-board.ts` | 修改 | 新增 `createGoal` / `createKR` / `createRequirement` / `createTask` 4 个 POST 函数 |
| `app/web/src/components/studio-page/component-board-edit-panel.tsx` | 修改 | 加 `mode:'create'\|'edit'` prop；form state + handleSubmit 拆到 `use-board-edit-form.ts` |
| `app/web/src/components/studio-page/use-board-edit-form.ts` | 新增 | form state hook（mode 无关，create 时返空 defaults，edit 时返 findEntity snapshot） |
| `app/web/src/components/studio-page/component-squad-board.tsx` | 修改 | 加 `onCreate(kind, parentGoalId?)` 回调；handleCreate 调 POST + 乐观添加 + 失败回滚 |
| `app/web/src/components/studio-page/component-board-goals-view.tsx` | 修改 | 加「+新建 Goal」入口；Goal 详情内「+新建 KR」入口；empty-state 改 CTA |
| `app/web/src/components/studio-page/component-board-requirements-view.tsx` | 修改 | 加「+新建 Requirement」入口；empty-state 改 CTA |
| `app/web/src/components/studio-page/component-board-tasks-view.tsx` | 修改 | 加「+新建 Task」入口；强制先选父 Requirement；empty-state 改 CTA |
| `specs/ui/components/studio-page/squad-board.md` | 修改 | 补 testid `squad-board-{entity}-create` + 创建 flow 章节（doc-modifier 阶段 5 实际改） |

### R2 + R4 + D8 对话 @mention 扩展
| 文件 | 操作 | 变更 |
|---|---|---|
| `app/shared/mention-resolver.ts` | 新增 | D8 resolver + PROVIDER_MATRIX 映射表 |
| `app/shared/__tests__/mention-resolver.test.ts` | 新增 | 6 个矩阵 key + default 兜底 UT |
| `app/server/src/mention/providers/workitem-provider.ts` | 新增 | WorkItemProvider（消费 BoardStore） |
| `app/server/src/mention/providers/member-provider.ts` | 新增 | MemberProvider（消费 SquadStore） |
| `app/server/src/mention/bootstrap-mention.ts` | 修改 | 注册 WorkItemProvider + MemberProvider（注入 BoardStore/SquadStore） |
| `app/server/src/bootstrap.ts` | 修改 | 把 BoardStore/SquadStore 传给 bootstrapMentionRegistry |
| `app/server/src/mention/search-service.ts` | 修改 | searchMentions 内 fetch session 后用 resolver 校验 provider ∈ 允许集合（未授权返 ProviderNotFoundError → 404） |
| `app/web/src/components/chat-page/component-chat-composer.tsx` | 修改 | PROVIDER_LABELS 扩 workitem/member；enabledProviders 从硬编码改 resolver 派生（各 section 调用点） |
| `app/web/src/components/chat-page/primitive-mention-pill.tsx` | 修改 | MentionIcon 加 workitem/member 分支 |
| `app/web/src/components/studio-page/section-squad-chat.tsx` | 修改 | enabledProviders 改 `resolveMentionProviders({biz:'studio', role:'squad', derivation:'main'})` |
| `app/web/src/components/studio-page/section-member-chat.tsx` | 修改 | enabledProviders 改 resolver 派生（leader/mate role 区分） |
| `app/web/src/components/chat-page/section-chat-detail.tsx` | 修改 | enabledProviders 改 resolver 派生（playground + subagent） |
| `specs/tech/mention/resolver.md` | 新增 | D8 概念 spec（已落） |
| `specs/tech/mention/provider-interface.md` | 修改 | §3 type 扩 + §7/§8 新 provider 要点（已落） |
| `specs/tech/mention/log.md` | 修改 | 追加 v0.0.68 条目（已落） |
| `specs/tech/mention/index.md` | 修改 | §⑥ 导航补 resolver.md（doc-modifier 阶段 5） |

### R3 看板 @按钮 → leader 对话预填
| 文件 | 操作 | 变更 |
|---|---|---|
| `app/web/src/components/studio-page/component-board-task-card.tsx` | 修改 | 加 `@` 按钮 + `onAtMention(type, path)` 回调 |
| `app/web/src/components/studio-page/component-board-goals-view.tsx` | 修改 | goal/kr 卡片加 @ 按钮 + onAtMention 透传 |
| `app/web/src/components/studio-page/component-board-requirements-view.tsx` | 修改 | requirement 卡片加 @ 按钮 + onAtMention 透传 |
| `app/web/src/components/studio-page/component-board-tasks-view.tsx` | 修改 | task 卡片 @ 按钮链路透传（task-card 已接） |
| `app/web/src/components/studio-page/component-squad-board.tsx` | 修改 | 接 onAtMention prop，透传到各 view |
| `app/web/src/components/studio-page/component-studio-board-route.tsx` | 修改 | 接 onAtMention prop，透传给 SquadBoard |
| `app/web/src/components/studio-page/page-studio.tsx` | 修改 | BoardRoute 接 onAtMention → setMainView({kind:'chat', node: leaderNode, prefill}); MainView.chat 加 prefill 字段 |
| `app/web/src/components/studio-page/component-studio-chat-router.tsx` | 修改 | 接 prefill prop，透传给 SquadChatPage / MemberChatPage |
| `app/web/src/components/studio-page/section-squad-chat.tsx` | 修改 | 接 prefill prop，透传给 ChatComposer |
| `app/web/src/components/studio-page/section-member-chat.tsx` | 修改 | 接 prefill prop，透传给 ChatComposer |
| `app/web/src/components/chat-page/component-chat-composer.tsx` | 修改 | 加 `initialContent?: MentionAttrs[]` prop；mount 时一次注入 pill |
| `specs/ui/components/chat-page/chat-composer.md` | 修改 | 补 `initialContent`（doc-modifier 阶段 5） |

### R5 工具 default + needReply
| 文件 | 操作 | 变更 |
|---|---|---|
| `app/server/src/tools/engine.ts` | 修改 | `validateInput` 末尾加 default-fill 循环（`obj[k] ??= schema.properties[k].default`） |
| `app/server/src/agent/tools/send-message-tool.ts` | 修改 | required 移出 needReply；needReply schema 加 `default:true`；normalize 改 `?? true` |
| `app/server/src/agent/tools/__tests__/send-message-tool.test.ts` | 修改 | 「needReply 缺失 → error」断言改「needReply 缺失 → default 生效（落库 needReply=true）」 |
| `app/server/src/tools/__tests__/engine.test.ts` | 新增/修改 | 加 default-fill 通用机制 UT（schema.properties[k].default → obj[k] 注入） |
| `specs/tech/multi_agent/[P1]subagent_derivation.md` | 修改 | §5 send_message schema needReply 改可选 default:true（doc-modifier 阶段 5） |
| `specs/tech/multi_agent/[P1]a2a_protocol.md` | 修改 | §4.2 needReply 字段语义改可选 default:true（doc-modifier 阶段 5） |
| `specs/tech/agent/tools/[P1]agent_tools.md` | 修改 | 补 §validateInput default-fill 通用机制（doc-modifier 阶段 5） |

### R6 squad chat model 展示 bug
| 文件 | 操作 | 变更 |
|---|---|---|
| `app/web/src/components/studio-page/component-studio-chat-router.tsx` | 修改 | 透传 `detail.modelDefault` 给 SquadChatPage |
| `app/web/src/components/studio-page/section-squad-chat.tsx` | 修改 | 接 squadModelDefault prop；modelOverride 初值派生；ModelPicker 接 inheritLabel/onInherit（照搬 member chat 模式） |
| `specs/ui/components/studio-page/squad-chat-page.md` | 修改 | 补「初值派生自 squad.modelDefault」+ ModelPicker inheritLabel 接线（doc-modifier 阶段 5） |

### R7 LLM 错误进 langfuse
| 文件 | 操作 | 变更 |
|---|---|---|
| `app/server/src/llm/caller/llm_caller.ts` | 修改 | invoke() 外层 catch 补 `endGenerationError`（用 observabilityEnded 标志避免重复 end） |
| `app/server/src/agent/agent-loop-observability.ts` | 修改 | 加 `markTraceError(reason)` 方法；run.error 路径调用，trace 设 level=ERROR；endTrace 签名不变 |
| `app/server/src/agent/agent-loop.ts`（run.error 路径） | 修改 | 调 `observability.markTraceError(reason)` 后再 endTrace（路径定位由 coder 读源码确认行号） |

## 6. 不变量（MUST NOT 违反）

1. `<mention type path/>` 自闭合标签端到端零转换不变（v0.0.45）
2. 复用 v0.0.60 已有 POST 端点，不发明 API
3. default-fill 通用机制（放 validateInput 末尾，不特例化 send_message）
4. llm_caller 所有 throw 前 endGenerationError（spec llm_caller.md:65）
5. 单文件 ≤ 300 行（component-board-edit-panel.tsx / component-squad-board.tsx 必须 hook 拆分保体量）
6. D8 resolver 单一映射表（client+server 共用，禁漂移）
7. endTrace 签名不变（避免破坏 4+ 调用点 + 测试）

## 7. 关联

- PRD：`specs/prd/version_logs/v0.0.68.md`（7 需求 + D8 + 19 用户路径 + 9 spec 待同步项）
- 决策权威：`states/v0.0.68.squad_ui_3/task.json`（D1-D8 + invariants）
- API 影响：`specs/api/version_logs/v0.0.68.md`
- UI 契约：`specs/ui/components/studio-page/squad-board.md`（R1/R3）+ `squad-chat-page.md`（R6）+ `chat-page/{chat-composer.md, mention-popover.md, mention-pill.md}`（R2/R3/R4）
