# v0.0.54.compaction 技术变更日志 — compact 409 简化 + subagent 放开 + prompt 回归 forked 不变量

> 范围红线：本版是 **compact 接口语义 + prompt 不变量** 三项修正，**不动 forked agent 执行机制**（forked buffer / NO_TOOLS / append-only cache 不变量不变）、**不动 tryCompact EP 契约**（§2c shouldCompact/doCompact 不变）、**不动 summaryTask CAS 模型**（idle/running/done/failed 旁路 CAS 不变）。
> 权威 spec：`specs/tech/agent/context/[P0]context_compact_detail.md §2b/§3`（409 + prompt）+ `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md §1`（task=directive 不变量）+ `specs/api/overall/04-agent-session.md §7`（HTTP 契约）。

---

## 1. 背景（为什么改）

v0.0.16 起 `POST /session/:id/compact` 接口在 `summaryTask.status==='running'` 之外，还拦 `session.state==='running' → 409 session_running` 与 `session.state==='interrupting' → 409 session_interrupting`，理由是「担心并发写 buffer 冲突」。**这是误解**：forked agent 是无副作用执行器（不碰 session.state/Run，与主对话 AgentLoop 在写 buffer 上正交），session.state 与 compact 是否能跑无关。真正需要互斥的是 compact 自身，由 `summaryTask` 检查 + `markSummaryRunning` CAS 已双层保证。

同时 `session.type==='subagent' → 403 subagent_readonly` 拦了手动 compact，但 **subagent 长跑上下文同样会爆炸**——自动 compact 路径已 work（不拦 subagent），手动 compact 被前端 guard 拦掉是 bug。

第三，v0.0.22 实现 compact prompt 时把 `serializeMessages(snap.messages)` 塞进 user message（`{{serialized_transcript}}` 占位符），导致 LLM 收到 `[system, ...messages(真身), reminder, userMessage(又把 messages 序列化复述一遍)]`——对话历史发两遍，违反 **forked 不变量**（buffer = snapshot 内容 + 追加指令；task message 是 directive 不复述）。

## 2. 三项变更

### 变更 1：409 规则简化（唯一 409 = compact_in_progress）

`POST /session/:id/compact` 触发条件（caller 校验）：

| 条件 | 行为 |
|---|---|
| `summaryTask.status === "running"` | `409 compact_in_progress`（前端按钮 disabled） |
| 任何 `session.state`（idle/running/interrupting/interrupted/error）+ `summaryTask.status ∈ {idle, done, failed}` | 通过 → 调 compact 执行路径 |

**删除的拦截**：
- `session.state==='running' → 409 session_running` ❌ 删
- `session.state==='interrupting' → 409 session_interrupting` ❌ 删

**双保险语义（简化后）**：
1. **接口层** `summaryTask` 检查（reject `running`）。
2. **内部层** `runCompact` 内 `markSummaryRunning` CAS（summaryTask: idle→running 原子切换，并发抢不到者抛错）。

session.state 不再参与。原则：**任何 session 任何时间都能 compact，除非 compact 正在跑**（subagent 防爆炸关键）。

### 变更 2：放开 subagent compact

`session-compact.ts` 删除 `session.type==='subagent' → 403 subagent_readonly` guard。subagent 长跑上下文也会爆炸，必须支持手动 + 自动 compact（共用同一 forked agent 路径）。

其他 subagent readonly 限制（POST messages/abort/clear 返 403）不变。

### 变更 3：T6 compact prompt 回归 forked 不变量（task = 纯 directive）

`compact.md` 模板正文整删：
- `{{serialized_transcript}}` 占位符 ❌（v0.0.22 实现曾塞 `serializeMessages(snap.messages)` 复述对话历史）
- `{{old_summary}}` 占位符 ❌（v0.0.22 实现的「老 summary 存在时插 merge 指令块」机制整体退场）

`CompactHandler.build()` 不再接任何 vars；`context-compact-runner.ts` `new CompactHandler().build().content` 直接取指令文本作 task message。`serializeMessages` 函数已删（无消费方 → 清死代码）。

**forked 不变量重申**（`agent_loop_forked.md §1`）：
1. snapshot 是唯一信息源（system + messages + reminder 已在 forked buffer 中）。
2. task message = 纯 directive（"对上面的对话历史做 X"），不复述 snapshot 任何内容、不注入老 summary / 序列化 transcript / 任何对话文本。
3. 违例特征：caller 在 task message 里塞 `serializeMessages(snap.messages)` / `JSON.stringify(snap.messages)` / `old_summary.content` → 对话历史发两遍，破坏 cache 命中。
4. 适用范围：所有 forked mode caller（compact / memory_extract / 任何未来旁路 EP）。

## 3. 代码落地（`app/server/src/`）

| 文件 | 操作 | 变更要点 | spec 对齐 |
|---|---|---|---|
| `handlers/session-compact.ts` | 修改 | 删 `state==='running'/'interrupting' → 409` 两条 guard；删 `session.type==='subagent' → 403` guard；唯一 409 = `summaryTask.status==='running' → compact_in_progress` | `api §7` + `context_compact_detail §2b` |
| `agent/context-compact-runner.ts` | 修改 | `taskMessage.content` 改为 `new CompactHandler().build().content`（纯 directive，不传 vars）；删 `serializeMessages` import + `oldSummary` 取值 | `context_compact_detail §3.0` + `agent_loop_forked §1` |
| `agent/context-compact-helpers.ts` | 修改 | 删 `serializeMessages` 函数（死代码——v0.0.54 prompt 改纯 directive 后无消费方） | `context_compact_detail §3.0` |
| `agent/context-engine.ts` | 修改 | 删 `serializeMessages` re-export（同上） | 同上 |
| `prompts/handlers/compact-handler.ts` | 修改 | `build()` 改 `return { content: this.readContent() }`（不再传 `serialized_transcript`/`old_summary` vars）；保留 `_ctx` 参数满足父类签名 | `prompt_content_files §4` |
| `prompts/content/compact.md` | 修改 | 整删 `{{serialized_transcript}}` + `{{old_summary}}` 占位符（保留 NO_TOOLS preamble + 9 板块 + 输出约束 + NO_TOOLS trailer 正文） | `prompt_content_files §5` |

**前端**（`app/web/src/components/chat-page/`）：

| 文件 | 操作 | 变更要点 | spec 对齐 |
|---|---|---|---|
| `component-usage-panel.tsx` | 修改 | `CompactBtn` `disabled` 改为只看 `summaryTask?.status === 'running'`（之前 `running || sessionBusy`）；`sessionBusy` 入参保留为 caller 兼容但组件内部忽略 | `ui/components/chat-page/component-usage-panel.md §3.3` |
| `section-chat-detail.tsx` | 修改 | readOnly mode（subagent）解除 CompactBtn 隐藏（之前 readOnly 不渲染 CompactBtn）；ClearBtn 仍按 readOnly 隐藏 | `ui/components/chat-page/_overview.md §4.3` |

**不改**（红线）：
- forked agent 执行机制（forked buffer / `buildForkedDeps` 装配 / NO_TOOLS / append-only cache）。
- tryCompact 胶水 + shouldCompact/doCompact EP（compact 触发判定不变）。
- summaryTask CAS 模型（`markSummaryRunning`/`markSummaryDone`/`markSummaryFailed` 不变）。
- 其他 subagent readonly 限制（POST messages/abort/clear 返 403 不变）。

## 4. 验证（UT + AT 真 LLM）

- **UT 23 pass**：覆盖 409 简化（唯一 compact_in_progress）+ subagent 放开（不再 403）+ prompt 纯 directive（Negative 断言 taskMessage 不含 `serializeMessages` / `old_summary` / `[user]` 等序列化痕迹，防回归）。
- **AT 5/5 pass**：真 LLM 跑通 5 条 case（手动 compact / subagent compact / 并发 compact 拒 409 / compact 成功 system message 留痕 / compact 失败 summaryTask 终态 failed）。

## 5. spec 同步清单（doc-modifier）

- `specs/api/overall/04-agent-session.md §7` — 409 简化 + subagent 放开（已对齐，含 v0.0.54.compaction 注释段）。
- `specs/api/overall/10-multi-agent.md §4.3` — subagent readonly 范围移除 compact（已对齐，含 v0.0.54 注释）。
- `specs/tech/agent/context/[P0]context_compact_detail.md §2b/§3` — 409 规则 + prompt = 纯 directive（已对齐）。
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md §1` — task=directive 不变量（已对齐，新增 v0.0.54 forked 不变量段）。
- `specs/tech/agent/context/[P0]prompt_content_files.md §3.2/§4/§5/§7` — compact.md 无占位符（已对齐）。
- `specs/ui/components/chat-page/_overview.md §4.3` — readOnly 保留 CompactBtn + 修正 disabled 描述（已对齐）。
- `specs/ui/components/chat-page/component-usage-panel.md §2/§3.3` — CompactBtn disabled 只看 summaryTask（已对齐，删 interrupting 行）。
- `specs/ui/overall/02-llm-chat.md` — subagent 只读页保留 CompactBtn（已对齐）。
- `specs/prd/overall/03-llm-chat.md` — subagent compact 放开（已对齐）。
- KB `index.md` / `log.md` — context + agent_interface_and_loop 两 KB 加 v0.0.54 entry（本次新增）。
