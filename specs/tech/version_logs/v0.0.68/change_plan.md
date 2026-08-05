# v0.0.68 Change Plan — method 级 review 合同

> version: 1.0 · 2026-07-05
> 用途：planner 按本表切 task（最粗 owning 级别）；coder 按本表实现；code-reviewer 按本表查偏离；实现严重违反 → 退 coder，2 次仍违反 → 退 architect。
> 行 = 一个函数/符号（新增 class/interface/type 各占一行）；8 列：模块 / 文件 / 函数·符号 / 类型 / 变更内容 / 约束 / 参考 / 影响行。
> 类型枚举：A=新增 / M=修改 / D=删除 / R=重构。
> 本表与 `change_log.md` §5 文件级叙事数据一致；本表是符号级汇总契约。

---

## R1 看板手动新建

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web/board-api | app/web/src/lib/squad-api-board.ts | createGoal | A | POST /squad/:id/board/goals 调用 helper | 复用 req() + callerHeaders；body 含 title+KR 嵌入数组 | 11b-squad-workitems.md §3.1 | +12 |
| web/board-api | app/web/src/lib/squad-api-board.ts | createKR | A | POST /squad/:id/board/goals/:gid/krs 调用 helper | 同上 | 11b-squad-workitems.md §3.2 | +10 |
| web/board-api | app/web/src/lib/squad-api-board.ts | createRequirement | A | POST /squad/:id/board/requirements 调用 helper | 同上 | 11b-squad-workitems.md §3.3 | +10 |
| web/board-api | app/web/src/lib/squad-api-board.ts | createTask | A | POST /squad/:id/board/tasks 调用 helper；body.source.requirementId 必填 | 端点校验 source.requirementId；UI 前置守卫 | 11b-squad-workitems.md §3.4 | +12 |
| web/board-edit | app/web/src/components/studio-page/use-board-edit-form.ts | useBoardEditForm | A | form state + handleSubmit hook（mode 无关）；create 时返空 defaults，edit 时返 findEntity snapshot；submit 时按 mode 调用方决定 create/edit 路径 | MUST 拆出以保 component-board-edit-panel.tsx ≤300 行；submit 回调签名 `(patch: BoardPatch) => void` 由 panel 绑定 create/edit 分支 | change_log §3.1；架构原则#5 | +120 |
| web/board-edit | app/web/src/components/studio-page/component-board-edit-panel.tsx | BoardEditPanel props | M | 加 `mode: 'create' \| 'edit'` prop（缺省 'edit' 向后兼容） | mode='create' 时 initial snapshot = defaults；findEntity 调用守卫（create 时 board 查不到不返 null） | change_log §3.1 | +6/-2 |
| web/board-edit | app/web/src/components/studio-page/component-board-edit-panel.tsx | BoardEditPanel 内部 state | R | form state + handleSubmit 移到 useBoardEditForm hook；panel 仅渲染 + 绑定 | MUST NOT 在 panel 内复刻 form state（双源漂移）；panel 行数 ≤300 | 架构原则#5 | -80/+15 |
| web/board | app/web/src/components/studio-page/component-squad-board.tsx | SquadBoardProps | M | 加 `onCreate?: (kind: BoardEntityKind, parentGoalId?: string) => void` prop | 透传到各 view；可选（不传则隐藏 +新建 按钮） | change_log §3.1 | +3 |
| web/board | app/web/src/components/studio-page/component-squad-board.tsx | handleCreate | A | 调 createGoal/createKR/createRequirement/createTask + 乐观添加到 board + 失败回滚 + flash toast | MUST 复用既有 handleSave 的乐观模式（applyBoardPatch）；成功后 reload（取响应层真值） | change_log §3.1；原则#1 | +35 |
| web/board-view | app/web/src/components/studio-page/component-board-goals-view.tsx | BoardGoalsView props | M | 加 onCreate / onAtMention prop；渲染「+新建 Goal」入口（testid `squad-board-goal-create`）+ Goal 详情内「+新建 KR」（testid `squad-board-kr-create`） | empty-state CTA 同入口（D1-a）；按钮位置不抢布局（顶部右上 / empty-state 居中） | squad-board.md testid 表 | +25 |
| web/board-view | app/web/src/components/studio-page/component-board-requirements-view.tsx | BoardRequirementsView props | M | 加 onCreate / onAtMention prop；渲染「+新建 Requirement」入口（testid `squad-board-req-create`）；empty-state CTA | 同上 | squad-board.md testid 表 | +20 |
| web/board-view | app/web/src/components/studio-page/component-board-tasks-view.tsx | BoardTasksView props | M | 加 onCreate / onAtMention prop；渲染「+新建 Task」入口（testid `squad-board-task-create`）；保存按钮 disabled until source.requirementId 非空（D1-b 强制） | MUST NOT 允许绕过 Requirement 直接建 Task；按钮 disabled 文案「先选父 Requirement」 | PRD §4.1 UC-3；D1-b | +28 |
| ui-spec | specs/ui/components/studio-page/squad-board.md | testid 表 | M | 补 `squad-board-{entity}-create`（4 个 entity）+ 创建 flow 章节（mode='create' 编辑面板入口） | doc-modifier 阶段 5 实际改；本行 planner 不切 task（属 doc 任务） | PRD §5 S4 | +15 |

## R2 + R4 + D8 对话 @mention 扩展

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| shared | app/shared/mention-resolver.ts | resolveMentionProviders | A | (kind: SessionKind) → MentionProviderName[]；PROVIDER_MATRIX 6 个 key + default 兜底 `[file, skill]` | MUST 是纯函数；MUST NOT 引用 server/web 包；放 shared 包前后端共用 | resolver.md §2/§4；架构原则#3 | +50 |
| shared | app/shared/mention-resolver.ts | PROVIDER_MATRIX | A | 6 映射表 key（playground/rocky/main 等）+ MentionProviderName type | 顺序稳定（file→skill→workitem→member）影响 tab 排列 | resolver.md §3 | +15 |
| shared-test | app/shared/__tests__/mention-resolver.test.ts | describe('resolveMentionProviders') | A | UT：6 矩阵 key 各一条 + default 兜底一条 | MUST NOT 进 server/web 测试套；MUST 用 vitest absolute path mock（如需） | memory/test-vitest-mock-absolute-path | +35 |
| mention-provider | app/server/src/mention/providers/workitem-provider.ts | WorkItemProvider class | A | 实现 MentionProvider；name='workitem' label='WorkItems'；search(ctx) 消费 BoardStore.getBoard(ctx.squadId,'all','active') → goals/requirements/tasks 全集 title 模糊匹配；MentionItem.path=`workitem/<kind>/<id>` | MUST 防御 ctx.squadId 缺失返空数组；MUST NOT 搜归档区；listView.subtitle=`${kind}·${status}` | provider-interface.md §7；D2 | +90 |
| mention-provider | app/server/src/mention/providers/member-provider.ts | MemberProvider class | A | 实现 MentionProvider；name='member' label='Members'；search(ctx) 消费 SquadStore.getSquad(ctx.squadId).members → name 模糊匹配；MentionItem.path=memberId | MUST 防御 ctx.squadId 缺失返空数组；MUST NOT 暴露 subagent；path 不嵌 name（D4） | provider-interface.md §8；D4 | +60 |
| mention-bootstrap | app/server/src/mention/bootstrap-mention.ts | bootstrapMentionRegistry | M | 注册 WorkItemProvider（注入 BoardStore）+ MemberProvider（注入 SquadStore） | MUST 复用 registry.register 模式；签名加 boardStore/squadStore 入参 | provider-interface.md §4 | +20/-2 |
| server-bootstrap | app/server/src/bootstrap.ts | bootstrap 调用 bootstrapMentionRegistry 处 | M | 把 BoardStore / SquadStore 实例传给 bootstrapMentionRegistry | 确认 store 实例化早于 mention registry 注册 | bootstrap-mention.ts 签名 | +3/-1 |
| mention-search | app/server/src/mention/search-service.ts | searchMentions | M | fetch session 后用 resolveMentionProviders({biz,role,derivation}) 校验 provider ∈ 允许集合；不∈ → throw ProviderNotFoundError（→ 404） | MUST NOT 改 handler 签名（service 内部完成）；service 已有 session 零额外 IO | resolver.md §5.2；search-api.md §4 | +12 |
| web-composer | app/web/src/components/chat-page/component-chat-composer.tsx | PROVIDER_LABELS | M | 扩 4 项：file/skill/workitem/member（label: Files/Skills/WorkItems/Members） | MUST NOT 改既有的 filter((name)=>!!PROVIDER_LABELS[name]) 模式（防御未识别 name） | chat-composer.md Props | +2 |
| web-composer | app/web/src/components/chat-page/component-chat-composer.tsx | ChatComposerProps | M | 加 `initialContent?: MentionAttrs[]` prop（mount 时一次注入 pill） | 与 R3 同文件不同行（共文件下钻方法级）；prop 受控、mount 注入、不破坏既有 enabledProviders/onSend | chat-composer.md Props（doc-modifier 阶段 5 补） | +6 |
| web-pill | app/web/src/components/chat-page/primitive-mention-pill.tsx | MentionIcon | M | 加 workitem/member 分支（workitem=任务卡 icon / member=成员头像 icon） | fallback @ 符号分支保留（兼容未来 provider） | mention-pill.md Props | +20 |
| web-section | app/web/src/components/studio-page/section-squad-chat.tsx | enabledProviders | M | 从硬编码 `['file','skill']` 改 `resolveMentionProviders({biz:'studio', role:'squad', derivation:'main'})` | squad 群聊必含 4 项（矩阵指定） | resolver.md §3 | +2/-1 |
| web-section | app/web/src/components/studio-page/section-member-chat.tsx | enabledProviders | M | 改 resolver 派生（用 member.role 区分 leader/mate） | leader/mate 均含 workitem，无 member（矩阵指定） | resolver.md §3 | +3/-1 |
| web-section | app/web/src/components/chat-page/section-chat-detail.tsx | enabledProviders | M | 改 resolver 派生（playground rocky + subagent readonly） | playground/subagent 仅 file+skill | resolver.md §3 | +3/-1 |
| tech-spec | specs/tech/mention/resolver.md | 整文件 | A | D8 概念 spec（映射表 + 函数签名 + 实现位置 + 测试覆盖） | **已落**（架构期产出，非 doc-modifier 阶段 5） | change_log §3.2 | done |
| tech-spec | specs/tech/mention/provider-interface.md | §3 MentionItem | M | type 字段注释扩 'file'\|'skill'\|'workitem'\|'member'（开放枚举）；path 补 workitem/member 编址 | **已落** | change_log §3.2 | done |
| tech-spec | specs/tech/mention/provider-interface.md | §7 WorkItemProvider + §8 MemberProvider | A | 新 provider 实现要点（搜索范围/数据源/匹配/MentionItem 映射/依赖注入/约束） | **已落** | change_log §3.2 | done |
| tech-spec | specs/tech/mention/log.md | v0.0.68 条目 | A | 追加 v0.0.68 mention KB 变更行（resolver.md 新建 + 2 provider + type 扩） | **已落** | change_log §3.2 | done |
| tech-spec | specs/tech/mention/index.md | §⑥ 导航 | M | 补 resolver.md 链接 | doc-modifier 阶段 5 | index.md §⑥ | +1 |

## R3 看板 @按钮 → leader 对话预填

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-board-card | app/web/src/components/studio-page/component-board-task-card.tsx | TaskCard props + @ 按钮 | M | 加 `onAtMention?: (type: string, path: string) => void` prop；卡片 hover 出现 @ 按钮（testid `squad-board-task-{tid}-at-mention`）→ onClick 调 onAtMention('workitem', `workitem/task/${tid}`) | @ 按钮位置不抢布局（hover 显示，预留空间）；onAtMention 可选（不传则不显） | PRD §4.3 UC-11；squad-board.md testid | +18 |
| web-board-view | app/web/src/components/studio-page/component-board-goals-view.tsx | goal/kr 卡片 @ 按钮 | M | 接 onAtMention prop；goal/kr 卡片加 @ 按钮（testid `squad-board-goal-{gid}-at-mention` / `squad-board-kr-{kid}-at-mention`）→ 调 onAtMention('workitem', `workitem/goal/${gid}` / `workitem/kr/${kid}`) | 同 TaskCard；view 透传 prop 到各卡片 | PRD §4.3 UC-10/UC-11 | +20 |
| web-board-view | app/web/src/components/studio-page/component-board-requirements-view.tsx | requirement 卡片 @ 按钮 | M | 同 goals-view；testid `squad-board-req-{rid}-at-mention`；path `workitem/requirement/${rid}` | 同上 | PRD §4.3 UC-11 | +12 |
| web-board | app/web/src/components/studio-page/component-squad-board.tsx | SquadBoardProps | M | 加 `onAtMention?: (type: string, path: string) => void` prop；透传到 3 个 view | 可选 prop；不传则各卡片 @ 按钮隐藏 | change_log §3.3 | +3 |
| web-board-route | app/web/src/components/studio-page/component-studio-board-route.tsx | BoardRoute props | M | 加 onAtMention prop，透传给 SquadBoard | 同上 | change_log §3.3 | +3 |
| web-page | app/web/src/components/studio-page/page-studio.tsx | MainView type | M | chat variant 加 `prefill?: MentionAttrs[]` 字段 | MUST NOT 加到 panel/board/member variant（仅 chat） | change_log §3.3 | +2/-1 |
| web-page | app/web/src/components/studio-page/page-studio.tsx | BoardRoute onAtMention handler | A | 处理 board @ 按钮 → 找 leader ChatNode（`detail.members.find(m=>m.role==='leader')`）→ setMainView({kind:'chat', node: leaderNode, prefill: [{type, path}]}) | MUST 用 detail.members leader 解析（复用既有模式）；leader 不存在时 toast 警告（防御） | change_log §3.3 | +18 |
| web-router | app/web/src/components/studio-page/component-studio-chat-router.tsx | StudioChatRouterProps | M | 加 `prefill?: MentionAttrs[]` prop，透传给 SquadChatPage / MemberChatPage | 可选；缺省不影响渲染 | change_log §3.3 | +5 |
| web-router | app/web/src/components/studio-page/component-studio-chat-router.tsx | leader session 路由分支 | M | isGroup=false 时 leader 节点渲染 MemberChatPage 传 prefill（透传 router prop） | 与 R6 同文件不同行；MUST 区分 leader/mate 路径分支 | change_log §3.3 | +2/-1 |
| web-section | app/web/src/components/studio-page/section-squad-chat.tsx | SquadChatPageProps | M | 加 `prefill?: MentionAttrs[]` prop | 可选；缺省不影响渲染 | change_log §3.3 | +2 |
| web-section | app/web/src/components/studio-page/section-squad-chat.tsx | ChatComposer initialContent 接线 | M | 把 prefill 透传给 ChatComposer 的 initialContent prop | 与 enabledProviders 行同文件下钻；initialContent 是 mount-time 受控注入 | change_log §3.3 | +2/-1 |
| web-section | app/web/src/components/studio-page/section-member-chat.tsx | MemberChatPageProps | M | 加 prefill prop；透传给 ChatComposer | 同 squad-chat | change_log §3.3 | +2 |
| ui-spec | specs/ui/components/chat-page/chat-composer.md | Props | M | 补 `initialContent?: MentionAttrs[]` 章节 | doc-modifier 阶段 5；引用 resolver.md | PRD §5 S3 | +10 |

## R5 工具 default-fill + needReply

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tools-engine | app/server/src/tools/engine.ts | validateInput | M | 末尾加 default-fill 循环：`for (const [k,sub] of Object.entries(schema.properties)) if (obj[k]===undefined && sub.default!==undefined) obj[k]=sub.default` | MUST 放末尾（required + 类型校验之后）；MUST NOT 特例化 send_message；所有工具受益 | D5；agent_tools.md（doc 同步） | +8 |
| tools-engine | app/server/src/tools/__tests__/engine.test.ts | default-fill UT | A | 新增 UT case：schema.properties[k].default → obj[k] 注入；已有值不覆盖 | MUST 验证 false-y default（如 default:false）也注入（!== undefined 判定） | change_log §3.4 | +30 |
| send-message | app/server/src/agent/tools/send-message-tool.ts | inputSchema.required | M | 移出 `'needReply'`（保留 'target','content'） | validateInput 不再因 needReply 缺失报错 | change_log §3.4 | -1 |
| send-message | app/server/src/agent/tools/send-message-tool.ts | inputSchema.properties.needReply | M | 加 `default: true`（与 description 一致：「通常需回复」） | D5 触发：validateInput 末尾 default-fill 注入 | change_log §3.4 | +1 |
| send-message | app/server/src/agent/tools/send-message-tool.ts | normalizeSendMessageInput | M | needReply 校验从「必须 boolean 否则 error」改 `needReply ?? true`（缺省视为 true） | MUST NOT 改显式 false（false 不被覆盖）；保留形态 A-D 容错链路 | change_log §3.4 | +4/-3 |
| send-message-test | app/server/src/agent/tools/__tests__/send-message-tool.test.ts | needReply 缺失 case | M | 断言从「needReply 缺失 → error」改「needReply 缺失 → default 生效，落库 sender.agent.needReply=true」 | MUST 加 case：显式 false 仍生效（不被覆盖） | PRD §4.5 UC-13/UC-14 | +8/-3 |
| tech-spec | specs/tech/multi_agent/[P1]subagent_derivation.md | §5 send_message schema | M | needReply 标「★ 必填」改「可选 default:true」+ normalize `?? true` | doc-modifier 阶段 5 | PRD §5 S6 | +3/-2 |
| tech-spec | specs/tech/multi_agent/[P1]a2a_protocol.md | §4.2 needReply 字段 | M | 同上 | doc-modifier 阶段 5 | PRD §5 S6 | +2/-1 |
| tech-spec | specs/tech/agent/tools/[P1]agent_tools.md | §validateInput default-fill | A | 补 §validateInput 末尾 `obj[k] ??= schema.default` 通用机制章节 | doc-modifier 阶段 5；MUST 引用 D5 决策 | PRD §5 S7 | +12 |

## R6 squad chat model 展示 bug

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-router | app/web/src/components/studio-page/component-studio-chat-router.tsx | SquadChatPage 渲染分支 | M | 透传 `squadModelDefault={detail?.modelDefault ?? ''}` 给 SquadChatPage | detail 可能 null → 兜底空串 | change_log §3.5 | +2/-1 |
| web-section | app/web/src/components/studio-page/section-squad-chat.tsx | SquadChatPageProps | M | 加 `squadModelDefault: string` prop（ModelRef string "providerId/modelId"，可空串=inherit） | 必填（缺省空串走 inherit 态） | change_log §3.5；member-chat-page.md §视觉基线 | +2 |
| web-section | app/web/src/components/studio-page/section-squad-chat.tsx | modelOverride initial state | M | 从 `null` 改派生自 squadModelDefault（拆 ModelRef → {providerId, modelId}；空串→null inherit 态） | MUST 复用既有 memberModelToSelection 模式（提取到 lib 共享或本地复刻） | change_log §3.5；section-member-chat.tsx:58-63 | +8/-1 |
| web-section | app/web/src/components/studio-page/section-squad-chat.tsx | ModelPicker JSX | M | 加 `inheritLabel={t('studio:chat.inheritLabel')}` + `onInherit={() => setModelOverride(null)}`（清空回派生态） | MUST NOT 改 per-call override 语义（仍前端 state，发送塞进 postMessage body，不调持久化 API） | change_log §3.5；squad-chat-page.md §[v0.0.63.ui_opt] | +3 |
| ui-spec | specs/ui/components/studio-page/squad-chat-page.md | §视觉基线 ModelPicker | M | 补「初值派生自 squad.modelDefault」+ inheritLabel 接线 | doc-modifier 阶段 5 | PRD §5 S5 | +8 |

## R7 LLM 错误进 langfuse

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| llm-caller | app/server/src/llm/caller/llm_caller.ts | invoke | M | 加 `observabilityEnded: boolean` 标志位；invokeCore 内部已 end 处置 true；外层 catch 判定 `if (!observabilityEnded && e 不是 ClassifiedLlmError)` 补 `ctx.observability?.endGenerationError?.(LlmErrorCategory.INTERNAL, msg, { retryChain: [] })` 后再 rethrow | MUST NOT 重复 end（invokeCore 内部各 throw 点已 end，外层只补未 end 的非 ClassifiedLlmError 异常）；spec llm_caller.md §2.1 line 65 不变量 | llm_caller.md §2.1 line 65；D7 | +12/-1 |
| llm-caller | app/server/src/llm/caller/llm_caller.ts | invokeCore 内部 throw 点 | M | 各 throw 前（line 269/295/338/346/400）已经调 endGenerationError 的位置不变；标志位置 true（在 endGenerationError 后） | MUST NOT 删任何既有 endGenerationError 调用；只加 observabilityEnded=true 标记 | change_log §3.6 | +5 |
| agent-observability | app/server/src/agent/agent-loop-observability.ts | markTraceError | A | 加 `markTraceError(reason: string): void` 方法；safe 调用 adapter.setLevel?(this.traceHandle, 'ERROR') 或等价机制；trace **metadata.errorLevel=ERROR** 落盘（langfuse ApiTraceBody 无 level 字段——见 BUG-001 等价机制说明） | MUST NOT 改 endTrace 签名（避免破坏 4+ 调用点）；adapter 不支持 setLevel 时 safe 吞 + warning | change_log §3.6；observability_interface.md（doc 同步）；BUG-001 决策 bbb1d339 | +18 |
| agent-loop | app/server/src/agent/agent-loop-base.ts 或 lifecycle（coder 定位 run.error 路径） | run.error handler | M | run 失败路径调 `observability.markTraceError(reason)` 后再 `endTrace(stopReason)` | MUST 在 endTrace 前调；trace level=ERROR 才能在 langfuse 顶层显 ERROR 而非 UNSET | change_log §3.6；D7 | +3 |
| agent-observability | app/server/src/agent/agent-loop-observability.ts | safe method | M | safe() 内部已 console.warn（line 322），dummy handle 返回前补 warning（可选，D7 标注） | MUST 现状已有 console.warn；本行可视为已满足，coder 确认即可 | D7 | +0/-0 |

---

## 任务切分建议（给 orchestrator 阶段 3 用）

按 owning 粗粒度建议（3-8 个 task，最终由用户协商定）：

1. **Task-1: 看板一等公民（R1）** — `coversFiles: [squad-api-board.ts, use-board-edit-form.ts, component-board-edit-panel.tsx, component-squad-board.tsx, component-board-{goals,requirements,tasks}-view.tsx]`。同模块集中，文件 owning 5+ 但语义一致（看板 CRUD UI）。
2. **Task-2: mention 子系统扩展 server 侧（R2+R4 server + D8 server）** — `coversFiles: [app/shared/mention-resolver.ts, app/shared/__tests__/mention-resolver.test.ts, app/server/src/mention/providers/{workitem,member}-provider.ts, app/server/src/mention/{bootstrap-mention,search-service}.ts, app/server/src/bootstrap.ts]`。概念一致：新增 2 provider + D8 resolver server 侧消费。
3. **Task-3: mention 子系统扩展 client 侧（R2+R3+R4+D8 client）** — `coversFiles: [component-chat-composer.tsx (PROVIDER_LABELS/initialContent), primitive-mention-pill.tsx, section-{squad,member}-chat.tsx (enabledProviders + prefill), section-chat-detail.tsx, page-studio.tsx (MainView.prefill), component-studio-chat-router.tsx, component-squad-board.tsx + 3 view + board-route + task-card (onAtMention 链路)]`。前端回路 + UI 拓展。
4. **Task-4: 工具 default-fill（R5）** — `coversFiles: [tools/engine.ts, send-message-tool.ts, send-message-tool.test.ts, tools/__tests__/engine.test.ts]`。后端独立模块。
5. **Task-5: squad chat model bug（R6）** — `coversFiles: [section-squad-chat.tsx, component-studio-chat-router.tsx]`。与 Task-3 同文件下钻方法级（squad-chat 仅 modelOverride init + ModelPicker props 行；router 透传 squadModelDefault 行），无重叠。
6. **Task-6: LLM 错误进 langfuse（R7）** — `coversFiles: [llm/caller/llm_caller.ts, agent/agent-loop-observability.ts, agent-loop run.error 路径]`。后端可观测独立模块。

> **建议 6 个 task**（满足 3-8 硬区间）；如用户要更细可拆 Task-3 为「mention UI 扩展（pill/composer）」+「@按钮回路（board/card/page-studio 链路）」两个。
> **同文件下钻**：section-squad-chat.tsx / component-studio-chat-router.tsx 在 Task-3 / Task-5 共用——coversMethods 必须方法级不重叠（squad-chat: enabledProviders 属 T3，modelOverride init 属 T5；router: prefill 透传属 T3，squadModelDefault 透传属 T5）。
