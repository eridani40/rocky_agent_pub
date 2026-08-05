# v0.0.42 PRD 变更日志 — session/run 两层状态 + 消息来源对齐 + IME 守护

## 概述

本版本交付 **chat 页 session 状态可见性的三处对齐**，全部源于真实使用反馈（`reqs/v0.0.42.session_state_ui/req.md`）：

1. **session/run 两层状态严格分离 + 切走切回 loading 恢复**：把「session 跑/停（粗）」与「run 思考/生成/调工具（细）」拆成两个独立可见元素——session 态驱动 **stop 按钮**（圆环动画+实心方框），run 态驱动 **on-message spinner**（贴流式尾部）；修切走切回 spinner 丢失 bug（让 run 生命周期标记在 agent_loop replay buffer 粘住）。**移除现有浮动 loading 胶囊**（§4.10）。playground + studio member-chat 同引擎同受益。
2. **消息来源左右对齐**：渲染内核加可选 `sideResolver`，单聊 a2a 收件→右（与 user 同侧，是「输入」）；群聊沿用默认（user 右 / a2a 左 / assistant answer+tool 屏蔽）。
3. **IME 中文输入选字回车误发送**：studio 两页 textarea 抄 playground 的 `isComposing || keyCode===229` 守护，组字中 Enter 不发送。

技术方案（replay buffer 粘住策略、sideResolver 入参签名、圆环动画实现）由 architect 落 `specs/tech/` + coder 落 `specs/ui/components/`，本 PRD 只描述诉求 + 引用已有概念。

权威输入：`reqs/v0.0.42.session_state_ui/req.md` + `states/v0.0.42/task-board.md`「设计方向」（用户逐点拍板）；概念权威源：见 §6 对齐确认。

---

## 1. 问题 1：session/run 两层状态分离 + 切走切回 loading 丢失

### 1.1 现状与根因

| 现状缺陷 | 代码/spec 定位 | 根因 |
|---|---|---|
| **切走切回 loading 气泡（spinner）消失**（即使 session 仍在跑） | `app/web/src/components/chat-page/use-session-run-state.ts` + `chat-slice-reducer.ts:118-123,286-296`（`runActive` 翻转）+ `context-port.ts:88,107,146`（`clearReplay` 三处） | `runActive` 仅由 agent_loop 的 `run_start/run_end` 翻转；切走切回 `reset()` 清 runActive=false → GET /session 返 running=true **只 set sessionRunning 不碰 runActive** → 重订阅 agent_loop 触发 replay，但 `run_start` 早被 `clearReplay`（ingest 时清 buffer）清出 → replay 不含 run_start → **runActive 整个剩余 run 恒 false，气泡永不回归** |
| **loading 胶囊（§4.10）用 run 层状态表达「session 在跑」语义混乱** | `chat-page/_overview.md §4.10`（`absolute left-10 bottom-[72px]` 浮动胶囊） | spec §4.10 自标「短暂差异属正常」严重低估实际切走切回场景；胶囊是 run 层派生（`runActive && loadingPhase!=null`）却承担 session 在跑的用户感知，职责错位 |
| **member-chat 同引擎同 bug** | `section-member-chat.tsx`（v0.0.39 P2 消费 `useSessionRunState`） | 共享引擎 = 共享 bug |
| **squad-chat 群聊无 loading 气泡** | `section-squad-chat.tsx`（纯轮询无 SSE） | 现状即正确（本版不涉及，见 §4 不覆盖项） |

### 1.2 方案（用户拍板，两层严格分离）

**核心原理（落 spec 必记）**：session 状态（粗，GET /session + `session_panel` SSE `session_status_update`）↔ run/message 状态（细，`agent_loop` 事件）**两层严格分离**——前者驱动 stop 按钮可见性，后者驱动 on-message spinner。

| 元素 | 层 | 可见性数据源 | 形态 | 位置 |
|---|---|---|---|---|
| **stop 按钮**（替代 §4.11b abort-btn） | session | `sessionRunning`（GET /session + `session_panel`，切回可恢复） | 外圈**旋转环动画**（accent，表达「running + 可中断」）+ 中心**实心方框**（stop icon）。interrupting 态（abort 收尾中）圆环**减速** | send 左侧（§4.11b 位置不变） |
| **on-message spinner**（替代 §4.10 浮动胶囊） | run | spinner 可见性跟 run 绑定（`runActive`：只要 run 活着就转，`run_end` 消失）；phase 文案跟「最后一个 agent_loop 生命周期事件」（可能显新 phase、也可能清掉 phase 文案，但 spinner 继续转到 run_end） | spinner + phase 文案**同一控件、状态各自决定**（4 阶段：thinking/answering/tool_calling/tool_executing，沿用 §4.10 表） | **贴当前 run 底部 / 流式尾部**（最新内容下方），auto-scroll 始终可见 |

**恢复机制（核心修法）**：让 `run_start`/`run_end` 这类 run 生命周期标记在 agent_loop replay buffer 里**粘住**——`clearReplay` 只清「已落盘的内容增量」（避免与 GET /messages 重复），**不清 run 生命周期标记**。切走切回重订阅时 replay 先送粘住的 `run_start` → 前端 `runActive` 恢复 → spinner 回来。

**移除**：现有浮动 loading 胶囊（`component-loading-status`，`absolute left-10 bottom-[72px]`），被「stop 按钮 + on-message spinner」替代。**enqueue 排队区保留**（属 session 层，与 loading 无关）。

**点击交互**：stop 按钮 click → `POST /session/:id/abort`（202 fire-and-forget，沿用 §4.11b），随后 `session_panel` 推 `state→interrupting`（圆环减速）→ `interrupted`（stop 按钮消失）。

### 1.3 影响范围

- **playground**（`section-chat-detail.tsx` + `chat-page/_overview.md`）：移除浮动胶囊 + 加 stop 按钮圆环动画 + 加 on-message spinner 组件 + 引擎 `useSessionRunState` 内调 replay 粘住逻辑。
- **studio member-chat**（`section-member-chat.tsx`）：同引擎 `useSessionRunState` 自动受益；run 态 UI 走共享组装层 `ComponentRunStateBar`（v0.0.39 P2 R3 已接，零额外接线）。
- **studio squad-chat**：**不改**（纯轮询，本版不涉及）。
- **后端**：replay buffer 粘住策略是否需后端配合（event-bus 侧），由 architect 判定（见 §6 新概念标注）。

---

## 2. 问题 2：消息来源左右对齐（单聊 a2a 收件→右）

### 2.1 现状与根因

| 现状缺陷 | 代码/spec 定位 | 根因 |
|---|---|---|
| **单聊 a2a 收件消息显示在左侧**（用户期望右） | `component-message-stream.tsx:109-114`（`sideOfMessage` 私有锁死） | `sender.source==='agent'` 永远→左，caller 无法干预（无 `sideResolver` 入参、ActorInfo 无 side 字段）。单聊 a2a 当前=左（❌ 与期望相反）；群聊 a2a 当前=左=期望（✅）；playground 潜在 a2a 同样相反 |

### 2.2 方案（渲染内核加 sideResolver）

**单聊（member-chat + playground）规则**：
- a2a inbox 收件消息（`role:'user'` + `sender.source:'agent'`）→ **右**（对该 session 是「输入」）
- assistant 自答 + 其 tool 调用 → **左**

**群聊（squad-chat）规则**（沿用默认，现状已正确）：
- user → 右
- a2a 收件 → 左
- assistant answer + tool → mute 屏蔽（不渲染）

**实现**：渲染内核 `component-message-stream` 加可选 `sideResolver?: (msg) => 'user'|'assistant'`。caller 传 resolver 时按 resolver；不传时走内核默认 `sideOfMessage`（user 右 / agent 左）。**内核默认逻辑不动 → playground a2a 场景零回归**（除非显式传 resolver）。

### 2.3 影响范围

- **渲染内核** `component-message-stream`：加 `sideResolver` prop（新概念，需落 tech/ui spec）。
- **studio member-chat**：传「a2a→右」resolver。
- **playground**：可不传（默认零回归）；若 a2a 场景也需对齐，显式传同款 resolver。
- **studio squad-chat**：不传 resolver（沿用默认）。

---

## 3. 问题 3：studio IME 中文输入选字回车误发送

### 3.1 现状与根因

| 现状缺陷 | 代码定位 | 根因 |
|---|---|---|
| studio 两页 textarea 组字中按 Enter **直接发送** | `section-member-chat.tsx:85-90` + `section-squad-chat.tsx:97-102`（`onKeyDown`） | studio v0.0.39 复刻输入框时**漏抄** IME 守护。playground `section-chat-detail.tsx:124-133`（v0.0.9 加）有 `imeComposing = e.nativeEvent.isComposing \|\| e.keyCode === 229` 守护 |

### 3.2 方案（抄 playground 守护）

studio 两页 textarea `onKeyDown` 加 2 行同款守护：组字中（`isComposing || keyCode===229`）的 Enter 不发送。三页各自内联 textarea（不共享组件）→ 改 2 处。playground 不动。

### 3.3 影响范围

- **studio member-chat** + **studio squad-chat**：各加 2 行守护。
- **playground**：不改（已有）。
- **UT**：照抄 `model-picker-and-input.test.tsx:138-199`（IME composition → Enter 不触发 send）。

---

## 4. 关键用户路径（MANDATORY — = 测试最低覆盖要求）

每条路径至少一个 API 或 E2E case。无 mock（遵循 memory `no-mock-api-e2e-tests`：真 LLM + 真服务）。

| 路径 | 链路 | 涉及功能 | 最低 case |
|---|---|---|---|
| **路径 A：loading 切走切回恢复** | 发消息 → session running（stop 按钮出现，圆环转）→ assistant 回复流式出现 + on-message spinner 在流式尾部转（phase 随事件切 thinking→answering→...）→ **切走到别的 session → 切回 → stop 按钮仍在（sessionRunning 恢复）+ spinner 仍在转（runActive 经 replay 粘住的 run_start 恢复）** → `run_end` → spinner 消失 + stop 按钮消失（sessionRunning=false） | 问题 1（两层分离 + replay 粘住） | ET（切走切回 spinner 恢复，vision_check 断言 spinner 存在） |
| **路径 B：abort interrupting 减速** | running 时点 stop 按钮 → POST abort（202）→ `session_panel` 推 `interrupting`（圆环**减速**动画）→ 推 `interrupted`（sessionRunning=false）→ stop 按钮消失 + spinner 消失（run_end）+ run-finish「已中断」 | 问题 1（stop 按钮 interrupting 态） | ET（点 stop → 圆环减速态 → 消失）+ AT（POST abort → state 序列 running→interrupting→interrupted） |
| **路径 C：单聊消息来源对齐** | 单聊里：user 发消息（右深底气泡）+ 其他 agent a2a 回复（右，`role:'user'+sender.source:'agent'`）+ 本 session assistant 回答（左 accent-surface，含其 tool 调用） | 问题 2（sideResolver 单聊 a2a→右） | ET（vision_check 断言 a2a 气泡在右侧 + assistant 在左侧） |
| **路径 D：群聊消息来源对齐（现状校验）** | 群聊里：user 消息（右）+ 各 a2a 回复（左）+ assistant answer/tool（屏蔽不渲染） | 问题 2（群聊默认 + mute） | ET（群聊 a2a 左 + 无 assistant answer/tool 节点） |
| **路径 E：IME 组字 Enter 不发送** | studio 单聊/群聊 textarea → 切中文输入法 → 输拼音组字（compositionstart）→ 按 Enter → **确认候选词（选 1），消息不发送** → 组字结束（compositionend）→ 再按 Enter → **发送** | 问题 3（IME 守护） | ET（Playwright 模拟 IME composition 事件 → 断言 send 按钮未触发 POST） |

---

## 5. E2E Use Cases（功能性，无视觉设计稿）

> 本版本**无设计稿**（`reqs/v0.0.42.session_state_ui/` 仅 req.md），视觉保真度比对项**跳过**（CLAUDE.md 原则 15）。E2E 覆盖 = 功能性断言（spinner 存在性 / 气泡左右位置 / 发送行为），不做视觉 compare。

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-42.1 | session A 发消息 → running → 切到 session B → 切回 A | stop 按钮仍在（圆环转）+ on-message spinner 仍在流式尾部转（runActive 恢复）；run_end 后两者消失 |
| UC-42.2 | session A running → 点 stop 按钮 | 圆环**减速**（interrupting 态）→ 转 interrupted 后 stop 按钮消失 + spinner 消失 + run-finish「已中断」 |
| UC-42.3 | member-chat：user 发消息 + 另一 agent a2a 回复 + assistant 自答 | a2a 气泡在**右侧**（与 user 同侧）+ assistant answer 在**左侧**（含其 tool 胶囊） |
| UC-42.4 | squad-chat：user 发消息 + 各 a2a 回复 + assistant answer/tool（被屏蔽） | user 右 + a2a 左 + assistant answer/tool 节点不渲染 |
| UC-42.5 | studio member-chat textarea：中文输入法组字中按 Enter | 选字确认（候选词 1），消息**未发送**（无 POST /messages）；组字结束后 Enter → 发送 |

---

## 6. PRD ↔ 概念 spec 对齐确认（MANDATORY）

逐条引用概念 spec，声明 PRD 与之**无矛盾**——PRD 是概念的产品化表达，新概念只描述诉求，详细技术定义留给 architect 落 tech spec + coder 落 ui spec。

| PRD 概念 | 概念 spec 权威源 | 对齐确认 |
|---|---|---|
| sessionRunning 权威源 = `session_panel` `session_status_update`（含 interrupting/interrupted 中间态） | `specs/tech/app/frontend/[P0]sse_channel.md §9`（[v0.0.13 S4] 切换）+ `specs/tech/agent/session/[P0]session_event.md §2-§3` | ✅ 一致——PRD §1.2 stop 按钮数据源引用同契约 |
| agent_loop replay buffer（subscribe 回放半截 + GET /messages 拼全量） | `[P0]sse_channel.md §10.7`（replayable 配置总表）+ `[P0]event_bus.md` + `agent_event.md §10` | ✅ 一致——PRD §1.2 恢复机制引用同 buffer；**粘住策略是新概念**（见下方标注） |
| run 生命周期事件（run_start/run_end）驱动 runActive | `specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §4`（AgentEvent 类型）+ `chat-slice-reducer.ts` | ✅ 一致——PRD §1.2 spinner 可见性跟 run 绑定引用同事件 |
| loading 4 阶段（thinking/answering/tool_calling/tool_executing） | `chat-page/_overview.md §4.10` 阶段表 | ✅ 一致——PRD §1.2 on-message spinner 沿用同 4 阶段文案表 |
| abort 4 步收尾（POST /session/:id/abort，202 fire-and-forget） | `chat-page/_overview.md §4.11b` + `03-llm-chat.md` 路径 H/T | ✅ 一致——PRD §1.2 stop 按钮点击交互引用同端点 + 同收尾 |
| enqueue 排队区（session 层，与 loading 无关） | `chat-page/_overview.md §4.11a` | ✅ 一致——PRD §1.2 明确 enqueue 保留不动 |
| message-row 三区对称（左头像列 / 内容列 / 右头像列） | `chat-page/_overview.md §4.6`（[v0.0.10] 三区对称） | ✅ 一致——PRD §2 sideResolver 只决定内容列左右，三区结构不变 |
| 群聊 mute（assistant answer+tool 屏蔽） | `specs/ui/components/studio-page/squad-chat-page.md`「渲染策略契约」 | ✅ 一致——PRD §2.2 群聊沿用默认 + mute 已确认正确 |
| member-chat 消费 `useSessionRunState` 共享引擎 | `specs/ui/components/studio-page/member-chat-page.md`「run 态契约」（v0.0.39 P2） | ✅ 一致——PRD §1.3 member-chat 同引擎同受益引用同契约 |
| IME 守护（isComposing / keyCode 229） | playground `section-chat-detail.tsx:124-133`（v0.0.9 实现） | ✅ 一致——PRD §3 抄同款守护；**spec 层无独立条目**（实现细节，UT 覆盖即可） |

> **新概念标注（交 architect/coder 落 ui/tech spec 后 PRD 才能转用户确认）**：
> 1. **run 生命周期标记在 replay buffer 粘住**——`clearReplay` 只清已落盘内容增量、不清 `run_start/run_end`。概念诉求在 PRD §1.2 恢复机制；技术定义（前端 `chat-slice-reducer` / `context-port` 改 clearReplay 范围，或后端 event-bus 侧配合）由 architect 落 `specs/tech/app/frontend/[P0]sse_channel.md`（§10.7 replay 语义补充）+ `[P0]component_architecture.md`。
> 2. **stop 按钮圆环动画 + interrupting 减速态**——`chat-page/_overview.md §4.11b`（component-abort-btn）需改写：从「红色方块按钮」改为「外圈旋转环 + 中心实心方框」+ interrupting 减速。视觉细节由 coder 落 `specs/ui/components/chat-page/component-abort-btn.md`（视觉基线字段）。
> 3. **on-message spinner 组件（run 层）**——`chat-page/_overview.md §4.10`（component-loading-status）需改写：从「浮动胶囊 absolute left-10 bottom-[72px]」改为「贴流式尾部 spinner+phase 同控件」。新增 `component-on-message-spinner` spec（或在 §4.10 原位改写）。
> 4. **`component-message-stream` 加 `sideResolver` prop**——渲染内核加可选 `(msg) => 'user'\|'assistant'` 入参，默认走 `sideOfMessage`。概念诉求在 PRD §2.2；技术定义由 architect 落 `specs/tech/app/frontend/[P0]component_architecture.md`（渲染内核契约）+ coder 落 `specs/ui/components/chat-page/component-message-stream.md`。

> **无矛盾确认**：PRD 引用的所有已有概念（sessionRunning 权威源 / replay buffer / run 生命周期事件 / loading 4 阶段 / abort 4 步 / enqueue / message-row 三区 / 群聊 mute / member-chat 共享引擎 / IME 守护）与对应 spec **完全一致**；4 个新概念（replay 粘住 / 圆环动画 / on-message spinner / sideResolver）PRD 只描述诉求不发明实现，待 architect/coder 落 spec 后回链核对。

---

## 7. 不覆盖项及理由

| 不覆盖项 | 理由 |
|---|---|
| **studio squad-chat 不加 loading 气泡 / stop 按钮** | 群聊纯轮询无 SSE 订阅，本版只保 playground + member-chat（用户拍板，task-board「设计方向」已定）；群聊 loading 后续单独立项 |
| **studio squad-chat 不加 sideResolver** | 群聊沿用默认（user 右 / a2a 左 / mute），现状已正确（task-board 调研-B 确认） |
| **playground a2a 场景是否需传 sideResolver** | 默认零回归；若用户后续要求 playground a2a 也对齐，显式传同款 resolver（本版不强制） |
| **视觉保真度 compare 跳过** | 本版本无设计稿（`reqs/v0.0.42.session_state_ui/` 仅 req.md），按 CLAUDE.md 原则 15 跳过 |
| **UT 覆盖 replay 粘住逻辑 + sideResolver 类型层** | 白盒，coder 单测（路径 A replay 恢复 + 路径 C sideResolver 分流） |

---

## 8. 待同步 overall 条目（doc-sync 阶段统一改，本步先标注）

版本合并前由 doc-modifier 同步（MANDATORY）：

- `specs/prd/overall/03-llm-chat.md`：
  - §3.1 期望行为条「loading 阶段胶囊」→ 改为「session/run 两层：stop 按钮（圆环）+ on-message spinner（流式尾部）」。
  - §4 关键用户路径表追加 v0.0.42 路径（A 切走切回恢复 / B abort 减速 / C 单聊对齐 / D 群聊对齐 / E IME）。
- `specs/prd/overall/08-squad-studio.md`（如有 member-chat/squad-chat 行为条）：补 sideResolver 单聊规则 + IME 守护条目。
- `specs/ui/components/chat-page/_overview.md`：§4.10（loading-status）+ §4.11b（abort-btn）改写 + §7 testid 表同步（圆环/spinner testid）。
- `specs/ui/components/chat-page/component-message-stream.md`（若存在独立 spec）：补 `sideResolver` prop。
- `specs/tech/app/frontend/[P0]sse_channel.md`：§10.7 replay 语义补「run 生命周期标记粘住」+ §9 两层状态分离说明。
- `specs/tech/app/frontend/[P0]component_architecture.md`：渲染内核 sideResolver 契约 + on-message spinner 组件架构。

---

## 9. 版本

v0.0.42（session/run 两层状态分离 + 消息来源对齐 + IME 守护。**3 问题**：① session/run 两层严格分离——session 态（GET /session + session_panel）驱动 stop 按钮（圆环动画+实心方框，interrupting 减速），run 态（agent_loop）驱动 on-message spinner（贴流式尾部，spinner+phase 同控件状态各自决定）；切走切回 spinner 丢失 bug 修法 = 让 run_start/run_end 在 replay buffer 粘住（clearReplay 只清已落盘内容增量）；移除现有浮动 loading 胶囊（§4.10），enqueue 排队区保留；playground + member-chat 同引擎同受益，squad-chat 不涉及。② 渲染内核 component-message-stream 加 sideResolver，单聊 a2a→右、群聊沿用默认。③ studio 两页 textarea 抄 playground IME 守护（isComposing / keyCode 229）。关键用户路径 5 条：A loading 切走切回恢复 / B abort interrupting 减速 / C 单聊 a2a→右 / D 群聊对齐现状校验 / E IME 组字 Enter 不发送。无设计稿，视觉保真度比对跳过。权威输入 `reqs/v0.0.42.session_state_ui/req.md` + `states/v0.0.42/task-board.md`「设计方向」（用户逐点拍板）；概念权威源 `specs/ui/components/chat-page/_overview.md §4.10/§4.11b/§4.6` + `specs/ui/components/studio-page/{member-chat-page,squad-chat-page}.md` + `specs/tech/app/frontend/[P0]sse_channel.md §9/§10.7` + `specs/tech/agent/session/[P0]session_event.md`。新概念（replay 粘住 / 圆环动画 / on-message spinner / sideResolver）PRD 仅描述诉求，详细 tech/ui 定义交 architect + coder）。
