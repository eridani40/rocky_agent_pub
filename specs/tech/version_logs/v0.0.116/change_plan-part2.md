# v0.0.116 变更计划书 part2 — presence 工具 / reminder / prompt / 前端 / 类型 / 单元测试

> 续 [`change_plan.md`](change_plan.md)（后端 scheduling/squad-runtime/store/API）。本 part 覆盖：presence 工具、squad_team_status reminder provider、prompt content、前端组件、类型/schema、单元测试、**禁改项**、**打包影响评估**。同 8 列（模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行）。

---

## 6. 后端 — presence 工具（新文件 + runtime context 扩展）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| presence-tool | app/server/src/agent/tools/runtime-context.ts | `AgentToolRuntimeContext.selfMemberId` | 新增 | 加 `selfMemberId?: string`（caller 自己 member id；presence 写自己 currentWork 用；standalone/subagent 不填） | MUST optional；MUST NOT 让 caller 传 memberId 参数 | squad_tools §6a；runtime-context.ts:94 selfSquadId 同模式 | +5 |
| presence-tool | app/server/src/agent/tools/presence-tool.ts | `presenceTool` | 新增（文件） | Tool 单例：name='presence'，inputSchema `{ required:['action'], properties:{ action:enum['set','clear'], text:string } }`；description 说明 set/clear 语义 + 仅写自己 | MUST 仅 action required；text 仅 set 读；schema flat 顶层声明 text（squad_tools §0 一致性） | squad_tools §6a schema | +40 |
| presence-tool | app/server/src/agent/tools/presence-tool.ts | `presenceTool.run` | 新增 | 从 `readRuntimeContext` 取 rtc；无 selfSquadId/selfMemberId/memberStore → errorResult（非 squad session 不可用）；`action==='set'` → text 空 → `presence_text_required` errorResult；read-modify-write：`memberStore.getMember(selfSquadId, selfMemberId)` → 剥信封 → `putMember({...rest, currentWork: action==='set' ? {text, updatedAt:now} : null})` → textResult `{ok:true}` | MUST 只写 `selfMemberId`（不接受 memberId 入参，防越权）；MUST 剥信封字段（createdAt/updatedAt/version）再 put；MUST NOT 记 lastWriteMessageId | squad_tools §6a；越权防护 PRD UC-14 | +45 |
| presence-tool | app/server/src/tools/registry.ts | `defaultTools` | 修改 | import `presenceTool` + 加进返回数组（squad tools 段） | MUST 注册到 defaultTools | registry.ts:71 | +2/-0 |
| presence-tool | app/server/src/agent/tool-policy.ts | `TOOL_POLICY['studio-leader'].bound` | 修改 | 加 `'presence'` | MUST leader bound | squad_tools §6a leader/mate 可用 | +1/-0 |
| presence-tool | app/server/src/agent/tool-policy.ts | `TOOL_POLICY['studio-mate'].bound` | 修改 | 加 `'presence'` | MUST mate bound | squad_tools §6a | +1/-0 |
| presence-tool | app/server/src/agent/tool-policy.ts | `TOOL_POLICY['studio-squad'].bound` | — | **不改**（SquadChat 不需要 presence，保持 `['send_message']`） | MUST NOT 加 presence 到 studio-squad | squad_tools §6a SquadChat 不需要 | +0/-0 |
| presence-tool | app/server/src/bootstrap.ts | `setBuildAgentToolContext` 闭包 | 修改 | 注入 `...(session?.memberId !== undefined ? { selfMemberId: session.memberId } : {})`（同 selfSquadId 模式） | MUST 从 session.memberId 镜像 | bootstrap.ts:625 selfSquadId 同模式 | +1/-0 |

---

## 7. 后端 — squad_team_status reminder provider（新文件 + squadContext 扩展 + 注册）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| reminder | app/server/src/agent/squad-reminder-deps.ts | `SquadReminderDeps.isSessionRunning` | 新增 | 加 `isSessionRunning(sessionId): Promise<boolean>`（开放点2 running 判定入口） | MUST 口径 `session.state==='running'` | 开放点2；reminder §4.6 | +3 |
| reminder | app/server/src/agent/squad-reminder-deps.ts | `SquadContextService.isSessionRunning` | 新增 | service 形态加同签名（provide 侧读） | MUST 与 rocky_context/types.ts 鸭子兼容 | reminder §4.6 | +2 |
| reminder | app/server/src/agent/squad-reminder-deps.ts | `makeSquadContextService` | 修改 | 代理 `isSessionRunning: (sid)=>Promise.resolve(deps.isSessionRunning(sid))` | MUST 透传 | reminder §4.6 | +2/-0 |
| reminder | app/server/src/bootstrap.ts | `setSquadReminderDeps` 调用点 | 修改 | 注入 `isSessionRunning: async (sid)=>{ const s=await store.getSession(sid); return s?.state==='running'; }` | MUST 用 store（SessionStore）；口径同 isSessionBusy | 开放点2；bootstrap.ts:725 | +4/-0 |
| reminder | app/plugins/builtins/rocky_context/types.ts | `SquadContextService.isSessionRunning` | 新增 | plugin 侧 service 类型加 `isSessionRunning(sid): boolean \| Promise<boolean>` | MUST 与 server 侧鸭子兼容 | reminder §4.6 | +2 |
| reminder | app/plugins/builtins/rocky_context/reminder/squad_team_status.ts | `SquadTeamStatusReminderProvider` | 新增（文件） | class extends ContextImplBase implements SystemReminderProvider；构造 `(implId, cfg)` | MUST 构造签名 `(implId,cfg)`（plugin_manager §3.4） | reminder §4.6 代码位 | +15 |
| reminder | app/plugins/builtins/rocky_context/reminder/squad_team_status.ts | `SquadTeamStatusReminderProvider.provide` | 新增 | 角色 filter：`readSessionType(ctx)!=='leader'` → `[]`；取 squadId → `squadContext.listMembers(squadId)` → 过滤 `isSessionRunning(m.sessionId)` → 格式化 `[squad:team-status]` 段（每 running 成员 name（role）：currentWork.text\|「（未标记）」；无 running → 「当前无成员在活跃工作」）；**不做变化检测/去重**（每轮直接产出） | MUST leader only；MUST 只列 running 成员；MUST NOT 走 §5 shouldProduce（每轮产出） | reminder §4.6 产出格式；§4.5 静态型同模式 | +40 |
| reminder | app/plugins/builtins/rocky_context/plugin.json | `squad_team_status` EP 注册 | 新增 | system_reminder EP entry：`{ implId:'squad_team_status', point:'system_reminder', impl:'./reminder/squad_team_status.ts', description:'__MSG_...__' }` | MUST implId=squad_team_status | reminder §4.6 | +6 |
| reminder | app/plugins/builtins/rocky_context/*/i18n（locale 资源） | `plugin.builtin.rocky_context.impl.squad_team_status.description` | 新增 | 加中英文 description key（防【资源X不存在】渲染） | MUST 两语言都加（memory i18n-key-add-checklist） | memory i18n-key-add-checklist | +2 |

---

## 8. 后端 — prompt content（leader/mate presence 维护句）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| prompt | app/server/src/prompts/content/squad/leader.md | presence 维护句 | 修改 | 加一句「被唤醒/接任务后先 `presence(set)` 标记当前工作，工作结束/无事时 `presence(clear)`」 | MUST 对齐 prompt_sections §3.1 | prompt_sections §3.1 | +2 |
| prompt | app/server/src/prompts/content/squad/mate.md | presence 维护句 | 修改 | 加同 presence 维护句（便于 leader 掌握团队状态） | MUST 对齐 §3.1 | prompt_sections §3.1 | +2 |

---

## 9. 前端 — autowork-tab 四块组合 + heartbeat-config + budget-meter 配置 + member-panel 移除

> heartbeat-config 逻辑较复杂（interval 单选 + activeWindows 多段增删 + scope 白名单勾选 + 校验/保存）——**预先切子组件防超 300 行**：主组件 `section-heartbeat-config.tsx`（壳 + 保存/dirty）+ 子组件 `heartbeat-window-list.tsx`（activeWindows 增删列表）+ `heartbeat-scope-picker.tsx`（scope switch + 白名单勾选）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-autowork | app/web/src/components/studio-page/component-autowork-tab.tsx | `AutoworkTab` | 修改 | 四块组合：SquadAutonomyToggle + **HeartbeatConfigSection（新增块）** + BudgetMeter（传 budget+onSaveBudget） + AutoWorkHistory；heartbeat-config props 传 squadId/enableHeartBeat/heartbeatConfig/members/timezone/onSave=onSaveMeta | MUST 四块 testid 都在（autowork-tab 容器 + 四子块）；MUST heartbeat/budget 走 onSaveMeta（PATCH /squad） | component-autowork-tab.md §testid；heartbeat-config.md | +12/-4 |
| ui-autowork | app/web/src/components/studio-page/section-heartbeat-config.tsx | `HeartbeatConfigSection` | 修改（重写） | per-member → squad 级：props 改 `{squadId, enableHeartBeat, heartbeatConfig, members, timezone, onSave}`；interval segmented chip（5/15/30/60，禁 select）；activeWindows 多段（子组件）；scope（子组件）；dirty/pending/error banner；save 调 `onSave({heartbeatConfig})`；reset 调 `onSave({heartbeatConfig:null})`；killswitch 关提示 | MUST 走 PATCH /squad heartbeatConfig（非 member 端点）；MUST interval 用 chip 非 select（§10）；MUST testid 去 {memberId} | heartbeat-config.md 全文 | +90/-120 |
| ui-autowork | app/web/src/components/studio-page/heartbeat-window-list.tsx | `HeartbeatWindowList` | 新增（文件） | activeWindows 多段增删：每段 time input start/end + 删除；「添加工作时间段」；空列表 `heartbeat-windows-empty` 提示；前端可提示段重叠/跨0点（后端 400 兜底） | MUST testid `heartbeat-window-add`/`-{idx}-start`/`-{idx}-end`/`-{idx}-remove`/`heartbeat-windows-empty`；≤300 行 | heartbeat-config.md §testid §状态 | +80 |
| ui-autowork | app/web/src/components/studio-page/heartbeat-scope-picker.tsx | `HeartbeatScopePicker` | 新增（文件） | scope switch（off=all/on=whitelist）+ on 时 deployed 成员勾选列表；提示「仅唤醒勾选成员，后续新增不自动纳入」 | MUST testid `heartbeat-scope-switch`/`heartbeat-scope-member-{memberId}`；≤300 行 | heartbeat-config.md §testid | +70 |
| ui-budget | app/web/src/components/studio-page/component-budget-meter.tsx | `BudgetMeter` | 修改 | props 加 `budget` + `onSaveBudget`；加配置交互：`budget-switch`（off=null 不限量/on=限量）+ on 展开 `budget-limit-input`（默认 1_000_000）+ `budget-save`；仪表展示部分不变（consumed/limit/remaining/windowEnd/bar/unlimited/超限） | MUST budget-switch off → onSaveBudget(null)；on → onSaveBudget({limit,window:'daily',scope:'team'})；MUST 布局稳定（§11） | budget-meter.md §状态 §testid | +55/-8 |
| ui-budget | app/web/src/components/studio-page/component-autowork-tab.tsx | BudgetMeter 调用 | 修改 | 传 `budget={detail.budget}` + `onSaveBudget={(b)=>onSaveMeta({budget:b})}` | MUST 走 onSaveMeta | budget-meter.md §数据来源 | （含 §9 AutoworkTab 行） |
| ui-member | app/web/src/components/studio-page/section-member-panel.tsx | `MemberPanel` | 修改 | 移除心跳 section（删 `HeartbeatConfigSection` import + `member-section-heartbeat` 渲染 + `onSaveHeartbeat` prop）；heartbeat 从 PatchMemberBody 剥离 | MUST 删净心跳 section + onSaveHeartbeat 链路 | member-panel.md §职责；PRD UC-9 | +2/-40 |
| ui-member | app/web/src/components/studio-page/use-member-panel-handlers.ts | onSaveHeartbeat 相关 | 修改/删除 | 删 onSaveHeartbeat handler（member heartbeat 端点废弃） | MUST 删净 | member-panel.md | +0/-15 |
| ui-member | app/web/src/components/studio-page/page-studio.tsx | onSaveHeartbeat wiring | 修改 | 删 member heartbeat PATCH 调用链（如有）；保留 patchSquad（onSaveMeta 已承载 heartbeatConfig/budget） | MUST 删净 member heartbeat 调用；MUST NOT 动 patchSquad | member-panel.md | +0/-8 |

---

## 10. 前端 — 类型 / API 客户端（squad-types 前端 + patchSquad）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| types | app/web/src/components/studio-page/squad-types.ts | `SquadHeartbeatConfig` | 新增 | interface `{ interval:number; activeWindows:Array<{start;end}>; scope:{mode:'all'\|'whitelist'; memberIds:string[]} }` | MUST 对齐 data_model §1.1a | data_model §1.1a | +8 |
| types | app/web/src/components/studio-page/squad-types.ts | `SquadDetail.heartbeatConfig` | 新增 | 加 `heartbeatConfig: SquadHeartbeatConfig \| null` | MUST 含 null | 11a §1.4 SquadDetail | +1 |
| types | app/web/src/components/studio-page/squad-types.ts | `Member.currentWork` | 新增 | 加 `currentWork?: { text:string; updatedAt:string } \| null`（回显用） | MUST optional | data_model §1.2b | +1 |
| types | app/web/src/components/studio-page/squad-types.ts | `PatchSquadBody.heartbeatConfig` | 新增 | 加 `heartbeatConfig?: SquadHeartbeatConfig \| null` | MUST 对齐后端 PatchSquadBody | 11a §1.4 | +1 |
| types | app/web/src/components/studio-page/squad-types.ts | `HeartbeatConfig`/`PatchHeartbeatBody` | 删除 | per-member 心跳类型废弃（member 端点删） | MUST 删净引用（member-panel/handlers 已删） | member-panel.md | +0/-8 |
| types | app/web/src/lib/squad-api.ts | `patchSquad` | 修改（如需） | 确保 PatchSquadBody 透传 heartbeatConfig（若客户端做字段白名单则加入；核对：现 patchSquad 若直接透传 body 则无需改） | MUST 透传 heartbeatConfig+budget | 11a §1.4 | +2/-0 |

---

## 11. 单元测试（gate 链 / 段校验 / scope filter / presence / provider / state v2）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ut | app/server/src/scheduling/handlers/__tests__/heartbeat-handler.test.ts | 全量重写 | 修改 | squad 级 gate：killswitch/window(多段+空=全天)/budget 队级 skip；逐成员 scope∩deployed∩非busy 展开；whitelist 非白名单跳过；benched 跳过；无 session 跳过 | MUST 覆盖 7 回归红线（squad 级重表述） | heartbeat_handler.md §4 | +全量 |
| ut | app/server/src/scheduling/__tests__/heartbeat-regression.test.ts | 全量重写 | 修改 | multi_squad_isolation / lastFiredAt 续接 / null-budget 放行 改 squad 级语义 | MUST squad 级 | heartbeat_handler.md §4 | +全量 |
| ut | app/server/src/scheduling/persistence/__tests__/heartbeat-adapter.test.ts | 全量重写 | 修改 | loadJobs 返 0/1 squad job；readSquad v1 忽略/v2 读；writeSquad 收敛 | MUST 覆盖 v1→v2 读时忽略 | heartbeat_handler.md §3 | +全量 |
| ut | app/server/src/squad/__tests__/squad-runtime.test.ts | 调整 | 修改 | reloadRole 删除（相关 case 删/改 reloadSquad）；registerHeartbeatJobs 返 0/1 | MUST 去 per-member case | heartbeat_handler.md §5 | +/- |
| ut | app/server/src/squad/scheduler/__tests__/scheduler-state.test.ts | 调整 | 修改 | readSquad/writeSquad v2；readRole/writeRole 删除 case | MUST 覆盖 v1 忽略 | heartbeat_handler.md §3 | +/- |
| ut | app/server/src/agent/tools/__tests__/presence-tool.test.ts | 新增（文件） | 新增 | set 写 currentWork / clear 置 null / 只写自己（无 selfMemberId → error）/ text 空 → presence_text_required / 非 squad session → error | MUST 覆盖越权防护（UC-14） | squad_tools §6a | +60 |
| ut | app/server/src/agent/tools/__tests__/squad-tool-schema.test.ts | 调整 | 修改 | presence schema flat 字段一致性纳入静态扫（若该测试覆盖全 squad 工具） | MUST presence schema↔handler 读字段一致 | squad_tools §0 | +/- |
| ut | app/plugins/builtins/rocky_context/reminder/__tests__/squad-team-status-provider.test.ts | 新增（文件） | 新增 | leader only 产出 / 只列 running 成员 / currentWork null → 「（未标记）」/ 无 running → 「当前无成员在活跃工作」/ mate 不产出 | MUST 覆盖 UC-11/12/13 | reminder §4.6 | +50 |
| ut | app/server/src/handlers/__tests__/squad-heartbeat-handler.test.ts | 删除 | 删除 | member heartbeat 端点测试废弃（端点删） | MUST 删净文件 | 11a §4.2 | +0/-全量 |
| ut | app/server/src/handlers/__tests__/squad-patch.test.ts（或 squad handler 测试） | 新增/调整 | 修改 | PATCH /squad heartbeatConfig 校验：interval 非枚举 400 / 段重叠 400 / start>=end 400 / scope.mode 非法 400 / 合法 200 回显 | MUST 覆盖 UC-8 段校验 | 11a §1.4 错误 | +40 |

---

## 12. 禁改项（防 coder 顺手扩展 — MUST NOT）

| 所属模块 | 符号 / 边界 | 禁改说明 | 参考 |
|---|---|---|---|
| eos | `<EOS>` / stop token 机制 | **零机制改动**（决策 3 硬约束）：`<EOS>` 只作为 §0.1 心跳提示词文案里的软出口引导。MUST NOT 扩展 stop token / MUST NOT 给 leader/mate 加 EOS 处理 / MUST NOT 动 SquadChat 现有 EOS 机制。成员无工具调用靠现有 `no_tool_call` 自然收尾。 | PRD §2.3 §5 OUT；heartbeat_handler.md §0 |
| engine | `engine.ts` / `scheduling/types.ts` | **引擎纯度**：MUST NOT 在 engine `isDue` 或 `IntervalSchedule` 引入 `activeWindows[]` 多段业务判定（开放点1：activeWindows 全下沉 handler gate）。engine 保持只判 interval isDue。 | 开放点1；index.md §④原则1 |
| tick-message | `buildTickUserMessage` | MUST NOT 改 `buildTickUserMessage`（file-watch 共享）；heartbeat 文案走新增 `buildHeartbeatTickMessage`（开放点5）。 | 开放点5 |
| budget | 消耗统计口径 | MUST NOT 新增调度消耗分桶（决策 4）：预算 gate 仍用现有 `Σ team session_usage total`（团队总消耗/天）。不改 budget-aggregator 消耗口径。 | PRD §2.2b 决策4；data_model §1.1a §88 |
| member-schema | `MemberSchema.fields.heartbeat` | MUST NOT 删 schema 声明（保留 dead 字段避免历史 record 读取炸）；只停代码读写。 | data_model §1.2 dead |
| runtime-migration | scheduler.json v1 数据 | MUST NOT 运行时破坏性清理 v1 `roles{}`（开放点3：读时忽略+存时收敛，无 version marker migration）。 | 开放点3；memory runtime-no-ext-policy-write |
| squad-chat | `TOOL_POLICY['studio-squad']` | MUST NOT 加 presence / heartbeat 到 SquadChat（决策6：SquadChat 无心跳、不需要 presence）。 | PRD §5 决策6；squad_tools §6a |
| member-panel-ui | member-panel「当前任务」 | 本版本 MUST NOT 加 currentWork 只读展示（开放点4：保持占位，留后续版本）。 | 开放点4 |

---

## 13. 影响面评估

- **跨模块**：scheduling（engine 不动 / handler+adapter+state+tick-message 改）、squad-runtime（job 注册 reload 改）、squad-store schema（squad+member 加字段）、squad-api（PATCH 校验 + 删端点）、agent tools（presence 新增）、rocky_context plugin（team-status provider 新增）、prompt content、bootstrap（3 处注入）、前端（autowork-tab/heartbeat-config/budget-meter/member-panel）、types、UT。
- **破坏性变更**：(a) `HeartbeatPayload` schema 变（去 memberId/sessionId）——per-member job 全废弃；(b) `PATCH /member/:mid/heartbeat` 端点删除（旧 client 调 → 404，可接受，UI 已撤）；(c) scheduler.json v1→v2（读时忽略旧 roles，最多漏一次心跳）。均 req 明确接受（不做兼容迁移，PRD §5 OUT）。
- **依赖顺序**（底层先）：① 类型/schema（scheduler/types.ts SquadHeartbeatConfig/MemberSnapshot + squad.ts/member.ts schema + 前端 squad-types）→ ② scheduling handler/adapter/state/tick-message → ③ squad-runtime job 注册 + boot deps → ④ squad-api PATCH 校验 + 删端点 + router → ⑤ presence 工具 + runtime-context + bootstrap 注入 → ⑥ team-status provider + squadContext 扩展 + plugin.json → ⑦ prompt content → ⑧ 前端组合 → ⑨ UT 全量重写。
- **风险点**：heartbeat handler + adapter + state UT 需**全量重写**（per-member → squad 级），风险中高（heartbeat_handler.md §1 已评估）。scheduler-state v1→v2 读兼容需 UT 兜底（读到 v1 roles 不炸、返 null）。presence 越权防护（只写 selfMemberId）需 UT 断言（UC-14）。

---

## 14. 打包影响评估（持续可打包护栏四类自查）

| 类别 | 本版本触碰？ | 判定 |
|---|---|---|
| ① 依赖归属（第三方 npm 进对应 workspace package.json） | **否** | 无新增第三方依赖。presence 工具/team-status provider 仅用现有 store/session 句柄 + node 内置。 |
| ② plugin 进 asar（新 builtin plugin / ext impl 能被 build-plugins 编译） | **是（需确认覆盖）** | 新增 `rocky_context/reminder/squad_team_status.ts` = **rocky_context builtin plugin 内新 impl**（非新 plugin 包）。build-plugins 编译 rocky_context 时应自动含新文件（同 squad_workspace.ts 模式，deep import 走既有 `@app/server` external）。**coder 需确认**：新 impl 无引入新第三方包（无需改 EXTERNALS）；plugin.json 新 EP entry 随 rocky_context 一起打包（copyResources 已覆盖 plugin.json）。presence 工具在 `app/server/src/agent/tools/`（server 自身代码，非 plugin），随 @app/server 打包，无 asar 额外处理。 |
| ③ 运行时配置注入 + 零密钥（新必需 env 键） | **否** | 无新增必需运行时 env 键。心跳配置落 squad record（DATA_DIR），非 env。 |
| ④ 路径/环境展开（新文件系统路径入口） | **否** | scheduler.json 路径复用现有 `SchedulerStateStore.filePath`（已 join root）；presence/currentWork 走现有 memberStore 写路径（已 resolveDataDir）。无新裸相对路径/字面 `~`。 |

**结论**：唯一需 coder 打包自查项 = **②** 确认 `squad_team_status.ts` 新 impl + plugin.json 新 EP 被 build-plugins 编译进 rocky_context 的自包含 `.cjs` + copyResources（预期自动覆盖，同 squad_workspace 先例）。其余三类不触碰。**dev AT/ET 测不到 packaged bug**——若时间允许建议对 team-status provider 跑一次 packaged 版验证（解包 asar 起后端确认 provider 非空壳），但非阻塞（无新依赖/env/路径，风险低）。
