# v0.0.47-ui_opt — 跨版本发布说明（tech 侧）

> version: 1.0 · 2026-07-02
> 版本类型：**UI 优化配套后端**（titled 字段 + auto_naming service + PUT title 广播补强 + resolveConfigBySid public）
> PRD 增量：`specs/prd/version_logs/v0.0.47-ui_opt/change_log.md`
> 架构：`states/v0.0.47.ui_opt/design.md`
> 测试：UT（auto_naming 29 + backend titled 8）/ AT（5 case，real LLM ark glm-5.2）/ ET（9 case）

---

## 1. 变更 KB 一览

| KB | 文件 | 变更摘要 |
|---|---|---|
| **agent/auto_naming**（新建 KB） | `index.md` | 5 章总起 + 7 条核心设计原则（首 query 触发 / CAS gate / 复用 LlmClient / 静默失败 / playground scope / fire-and-forget / runtime 直调 broadcaster） |
| | `[P0]auto_naming_service.md` | 触发 hook（handleMessagesPost line 180-184 fire-and-forget）+ 三段 gate（playground scope / 首 query transcript scan / titled 防御）+ CAS 应用（re-read titled===false → 写 + broadcaster.broadcast）+ NAMING_PROMPT（maxTokens:32 / temperature:0）+ extractPlainName 3 趟 regex 净化 + 错误处理矩阵 + 与 PUT title 路由协作（竞态矩阵 4 case） |
| | `log.md` | 新建（含 2026-07-02 doc-modifier drift 订正条目） |
| **agent/session** | `index.md` | ④ 加第 8 条核心原则「titled lazy 默认 false 不跑 migration」；⑤ 加 auto_naming 关联 KB 引用 |
| | `[P0]session_store.md §2` | Session interface 加 `titled?: boolean`（lazy 默认 false；createSession 强制写 false；置 true 两 timing：AI 应用 / 用户改名）；line 号校正（applyTitleUpdate helper 抽出后） |
| | `[P0]session_event.md §3a` | `SessionMetaView` 加 `titled: boolean` 字段；§3a.4 触发时机表加 v0.0.47 两行（PUT body.title / AI 起名 CAS broadcaster 直调） |
| | `log.md` | 追加 2026-07-01 v0.0.47 + 2026-07-02 doc-modifier 同步条目 |

## 2. 后端改动清单（文件级）

| 文件 | 操作 | 内容 |
|---|---|---|
| `app/server/src/agent/auto-naming-service.ts` | **新增** | `AutoNamingService` 类（triggerIfFirstQuery + applyAiName + extractPlainName + NAMING_PROMPT）；deps: `{ store, agentManager, metaBroadcaster? }`；单文件 168 行 |
| `app/server/src/agent/session-store-types.ts` | 修改 | `Session.titled?: boolean`（注释含 lazy 默认 / 置 true 两 timing / 兼容历史） |
| `app/server/src/agent/session-store-converters.ts` | 修改 | `toSession` 加 `titled: r.titled === true`（lazy false 兼容历史 record） |
| `app/server/src/agent/session-store.ts` | 修改 | `createSession` 强制写 `titled: false`（防御 caller 透传）；`updateSession` patch 含 titled → `=== true` 规范化 |
| `app/server/src/agent/session-event-types.ts` | 修改 | `SessionMetaView` 加 `titled: boolean`（对齐 GET /session shape） |
| `app/server/src/agent/session-meta-broadcaster.ts` | 修改 | `sessionToMetaView` 序列化 `titled: s.titled === true`（二次防御） |
| `app/server/src/handlers/session.ts` | 修改 | PUT body.title 路径同步置 `titled: true`（line 184-195）+ 写完调 `metaBroadcaster.broadcast(id)`（line 195） |
| `app/server/src/handlers/session-update.ts` | 修改 | PUT workspaceDir + title 复合路径：抽 `applyTitleUpdate(deps, id, title)` helper（同步置 titled=true + broadcast）；两分支（仅 title / workspaceDir+title）复用 |
| `app/server/src/handlers/session-messages.ts` | 修改 | `handleMessagesPost` line 180-184：userMsg 构造后、deliverTo 前加 fire-and-forget hook（`void autoNamingService.triggerIfFirstQuery(id, plainText).catch(()=>{})`） |
| `app/server/src/handlers/session.ts`（deps） | 修改 | `SessionHandlerDeps` 加 `autoNamingService?: AutoNamingService`（optional，旧测试不注入则 no-op） |
| `app/server/src/bootstrap.ts` | 修改 | 实例化 `AutoNamingService({ store, agentManager, metaBroadcaster })`（与 unreadRuntime / session handler 共享同一 metaBroadcaster 实例）+ 注入 SessionHandlerDeps |

## 3. 关键设计决策（architect 定）

1. **titled lazy 默认 false，不跑 migration**——`titled?: boolean` optional；首 query 触发条件（transcript 无 prior role=user）天然保护现存 session（都有 prior user 消息）不被误触发。对齐 bizType（v0.0.33.1）/ unread（v0.0.27）lazy 默认先例。
2. **CAS gate（titled===false）**——AI 名返回时 re-read session，仅当 titled 仍 false 才写 `{title, titled:true}` + 触发 `metaBroadcaster.broadcast(sid)`；用户改名 PUT body.title 也置 true → 永不被 AI 名覆盖。
3. **playground scope gate**——仅 `bizType==='playground' && type!=='subagent'` 触发；studio 域（squad/leader/mate/studio subagent）有 member identity 不起名。
4. **复用 LlmClient.call（非 LlmCaller）**——`agentManager.resolveConfigBySid(sid).client.call({messages, params:{maxTokens:32, temperature:0}})` 单次非流式调用；不引 LlmCaller 策略层（一次性低风险调用，retry/降级成本高于收益）；失败静默。
5. **fire-and-forget**——`handleMessagesPost` 不 await auto-naming promise；主 run 立即返回 202。AI 名在主 run 流式回答期间或结束后到达，经 `session_meta_update` 广播让列表 reducer 整条替换。
6. **runtime 自治直调 broadcaster**——AI 名应用后直接调 `metaBroadcaster.broadcast(sid)`（同 markUnreadTrue 模式）；不走 statusBus（title 更新是纯 CRUD 写、不经状态机）。
7. **`resolveConfigBySid` public**——AutoNamingService 调用暴露此方法（原本仅 AgentManagerImpl 内部用）；方法签名不变。
8. **broadcaster 同步 void**——`SessionMetaBroadcaster.broadcast` 是同步 void + 内部 try/catch 吞异常，调用层无需 await、无需外层 try（auto-naming-service.ts:134 + session-update.ts:43 都按此调用）。

## 4. 验收

- 所有 4 task verified（UT 总 3872 pass + AT 4 PASS+1 SKIP + ET 2 PASS+7 conflict dom-verified + 0 hard_fail）
- code review：3 组全 CONDITIONAL_PASS（Minors 直接修复）
- 关键路径 A/D/E/F 全 dom-verified（conv_item_rename_tc1 / conv_item_row_expand_tc1 真 LLM subagent 全 PASS）
- ET 抓到并修 1 真 bug（编辑态 input borderless 不可见 → 加 outline-accent+bg-surface-2+box-border，布局稳定）

## 5. 兼容性

- **HTTP 契约**：`POST /messages` / `PUT /session/:id` / `GET /session` 契约 shape 不变（仅 Session 响应加 `titled: boolean` 字段；AI 起名是纯后台副作用）。
- **新字段 `titled`**：lazy 默认 false；前端 reducer 整条替换不读此字段（仅 AI 起名 service CAS gate + 可观测用）。
- **依赖**：`resolveConfigBySid` 仍 public；autoNamingService optional（旧测试不注入则 no-op）。
