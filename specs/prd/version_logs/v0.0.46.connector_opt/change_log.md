# v0.0.46.connector_opt — 连接器 lazy connect 时机重构（PRD 增量）

> 版本类型：**内部时机重构**（用户可感知：app 启动不再弹「有应用要调试」；LLM 视角新增 `disconnect` action）
> 概念权威源：`specs/tech/config/[P1]connectors.md`（v1.1）+ `specs/tech/agent/tools/[P1]browser_tool.md`（v1.4）+ `specs/ui/overall/05-connectors.md`
> 归属 overall：`specs/prd/overall/07-web-tools.md` §7.2.3 / §7.2.4
> 测试范围：**仅 UT**（用户明确不做 API/E2E test）
> 无设计稿——UI 交互文本微调，视觉基线延用现有 connector-page

---

## 1. 背景与问题

### 1.1 现状（截至 v0.0.34）

- **bootstrap 立即 connect**：`ConnectorManager.bootstrap()` 在 app 启动时读持久化 intent，`enabled=true` 即调 `ChromeMcpDriver.connect(--autoConnect)` 尝试 attach（`connectors.md` §3.3）。
- **switch=on 语义混合**：switch 既是「用户启用意图」也是「连接触发信号」——用户 toggle on 那一刻起，只要 intent 持久化为 true，未来每次 app 启动都会自动尝试 connect。
- **副作用**：由于 chrome-devtools-mcp `--autoConnect` 在 chrome 未开时会自启一个空 chrome（`browser_tool.md` §4.1「autoConnect 副作用承认存在」），**每次 app 启动 = 弹一次「有应用要调试」系统 prompt**——即使用户当次并不打算用 attach。

### 1.2 根因

把 switch=on 当作「立即 connect 意图」是设计偏差。**switch 应仅表达「功能是否可用」**（feature flag），**connect 时机应由「实际使用需求」触发**——只有 LLM 真正调 browser tool 的 attach mode 时才需要连接。

用户原话：「现在每次启动 chrome 都会弹一个申请，有应用要调试，这个太不合理了。」

---

## 2. 目标（v0.0.46）

1. **switch 退化为纯功能开关**：只表达「用户是否允许在此机器上使用 browser attach 模式」，**不再触发 connect**。
2. **Lazy connect on demand**：connect 仅在 `browser` tool `run(mode='attach', ...)` 首次调用时触发（switch=on 前置门禁 + 未连接 → 立即 connect + 引导用户）。
3. **显式 disconnect action**：LLM 在 attach 任务收尾时可主动 `browser({mode:'attach', action:'disconnect'})` 释放连接（保留 session 结束/idle 兜底自动 disconnect）。
4. **attach 资源全局唯一**：整个 app 内 attach session 单例；被某 session 占用时其他 session 调 attach 直接返回 ToolError。
5. **重启零副作用**：app 重启不再自动尝试 connect，不再触发「有应用要调试」系统 prompt。

---

## 3. 概念与状态机变化

**双状态机语义保留**（switch=on/off + connection=disconnected/connecting/connected/error），**触发时机改动**——即状态本身的定义不变，改的是「什么时候进入哪个态」。

### 3.1 触发时机对照（关键差异）

| 触发事件 | v0.0.34 现状 | **v0.0.46 目标** |
|---|---|---|
| **app 启动，持久化 intent=on** | ConnectorManager `bootstrap()` 读 intent → 立即 `connecting` → 调 driver.connect（自启 chrome） | **不 connect**。仅从持久化读 intent 恢复 switch UI 态；connection 保持 `disconnected` |
| **用户点 toggle on** | intent=on + `connecting` + 立即调 driver.connect | **仅 intent=on 持久化**；switch 显 on（表达「已启用」意图）；connection 保持 `disconnected`；不触发 connect |
| **LLM 调 `browser({mode:'attach', action:X})`（switch=on 且 disconnected）** | 直接读 ConnectorManager session（已 connected）→ 走 action | **首次触发 lazy connect**：进 `connecting` → 引导用户开 chrome remote debugging → attach 成功 → connection=connected → 走原 action |
| **LLM 调 `browser({mode:'attach', action:'disconnect'})`** | 无此 action | **新增**：断开 session（graceful close + kill MCP 进程，不杀 chrome）→ connection=disconnected；switch=on 保持 |
| **LLM 调 attach，switch=off** | 门禁返回「未连接...请开启」 | 语义不变，仍返回原有「未启用」错误（不 lazy connect） |
| **LLM 调 attach，其他 session 已占用 attach** | （无此场景，全局单实例但未显式冲突处理） | **返回 ToolError**（isError=true）「browser attach 已被 session=X 占用，请先在该 session disconnect」，**不通过 UI 通知** |
| **用户点 toggle off** | intent=off + 停止 attach | 语义不变（若当前 connection≠disconnected → 顺带 disconnect）|
| **session 结束/agent idle 超时** | （已有兜底） | **保留**：兜底自动 disconnect，避免长期占用 |

### 3.2 状态字段（不变）

```typescript
interface ConnectorState {
  id: 'browser';
  switch: 'on' | 'off';              // 语义：用户启用意图（不再实时反映连接态）
  connection: 'disconnected' | 'connecting' | 'connected' | 'error';
  errorDetail?: string;
  lastConnectedAt?: number;
}
```

**关键语义调整**：v0.0.34 spec 描述 switch=on「实时表示已连上」；v0.0.46 后 **switch=on 表示「用户已启用此功能」**——与 connection 独立。UI 呈现见 §5。

### 3.3 全局单例约束（新增）

- ConnectorManager 全局持有 **至多一个** attach session。
- 建立时记录 owner（最近调用 attach 的 sessionId）；同 owner 复用；不同 owner 触发占用错误。
- disconnect（LLM 主动 / 自动兜底）后 owner 清空，任意 session 可重新占用。

> owner 具体识别粒度（sessionId / conversationId / requestId）由架构阶段在 `connectors.md` 敲定；PRD 只声明「全局唯一 + 冲突报错」的产品语义。

---

## 4. 关键用户路径（MANDATORY）

| ID | 用户 / LLM 操作链路 | 预期结果 | 类型 |
|---|---|---|---|
| **P1** | 用户进连接器页 → 点浏览器 toggle on | intent=on 持久化；UI toggle 显 on；status 文本显「已启用（未连接）」；**不唤起 chrome、不进 connecting**（对比 v0.0.34：会立即 connecting） | UT + 手工冒烟 |
| **P2** | switch=on + connection=disconnected → LLM 调 `browser({mode:'attach', action:'navigate', url})` | 首次触发 lazy connect：进 connecting → 引导（若 chrome 未开 remote debugging，返回引导错误 or 完成 attach 后走 action）→ attach 成功 → 执行 navigate → 返回结果；ConnectorManager 记 owner=当前 session | UT |
| **P3** | 已 connected（P2 之后）→ LLM 调 `browser({mode:'attach', action:'disconnect'})` | driver 断开（graceful close + kill MCP 进程，**不杀 chrome**）→ connection=disconnected；owner 清空；switch=on 保持；返回 `{content:[text('browser attach 已断开')], isError:false}` | UT |
| **P4** | session A 已 attach（owner=A）→ session B 调 `browser({mode:'attach', action:'listPages'})` | session B 收到 ToolError：`{content:[text('browser attach 已被其他会话占用，请先在该会话调用 disconnect')], isError:true}`；不影响 A 的 session；**不产生 UI 通知** | UT |
| **P5** | 持久化 intent=on → app 重启 | 启动读 intent → switch UI 显 on；connection=disconnected；**不 connect、不 spawn chrome-devtools-mcp、不弹「有应用要调试」prompt**（对比 v0.0.34：会立即 bootstrap connect）；status 文本显「已启用（未连接）」 | UT + 手工冒烟 |
| **P6** | switch=off → LLM 调 `browser({mode:'attach', action:X})` | 立即返回原有引导错误：`{content:[text('browser attach 未启用：请在「连接器 → 浏览器」中开启开关')], isError:true}`；**不 lazy connect** | UT |
| **P7** | 已 connected 的 session 结束（chat 关闭 / idle 超时） | 兜底自动 disconnect：driver 释放 → connection=disconnected → owner 清空；switch=on 保持 | UT |
| **P8** | LLM 调 attach lazy connect 失败（chrome 未开 / 版本 <144 / 拒绝 prompt） | connection=error + errorDetail 记原因；owner 不写入；返回 ToolError 引导用户；**不重试循环**（沿用 v0.0.34「失败即停」） | UT |

**测试范围声明**：本版本仅 UT。API/E2E 因用户明确豁免不做——PRD 记录以上 8 条路径作为架构阶段与后续版本回归的用户价值锚点。

---

## 5. UI 表现调整（微调，无视觉重构）

对齐 `specs/ui/overall/05-connectors.md` §3 状态机表格，需在架构阶段同步修订以下呈现——PRD 层锁定语义：

| 组合态 | v0.0.34 status 文本 | **v0.0.46 status 文本** |
|---|---|---|
| switch=off, connection=disconnected | 「未连接」 | 「未启用」 |
| switch=on, connection=disconnected | （不存在稳定态） | **「已启用（未连接）」** — 灰点，对齐 disconnected 视觉 |
| switch=on, connection=connecting | 「连接中…」 | 「连接中…」（不变；仅在 LLM 触发 lazy connect 时短暂出现） |
| switch=on, connection=connected | 「已连接」 | 「已连接」（不变） |
| switch=on, connection=error | 「连接失败」 | 「连接失败」（不变；lazy connect 失败或运行中断） |
| switch=off, connection=error | — | 保持一致收敛到 disconnected（switch=off 时不展示 error 状态） |

**guide 面板**（`browser-connector-guide`）现有 4 步引导保留；副标题措辞可从「打开开关即连接」改为「打开开关启用后，agent 首次使用时会连接」（架构阶段落 UI spec）。

---

## 6. 对齐既有 spec 的差异清单（架构阶段需同步修正）

以下段落**在架构阶段** 由 arch 更新对应 tech / ui spec；PRD 层仅记录待修点，**不擅自动 tech spec**（当前 tech spec 以旧行为为准，属于「PRD 引入的时机变更」需 tech 同步）。

### 6.1 `specs/tech/config/[P1]connectors.md`

| 段落 | 当前描述 | v0.0.46 后应改为 |
|---|---|---|
| §2「switch 语义」 | 「switch 的 on 实时表示已连上；持久化值是用户意图」 | switch 与 connection **完全解耦**：switch=on 仅表示用户已启用；连接实况全部由 connection 表达 |
| §3.2 迁移表「用户点 toggle on」触发列 | 立即 connecting + 调 driver.attach | 仅 intent=on 持久化 + switch UI=on；不进 connecting、不调 driver |
| §3.2 迁移表新增行 | — | 「LLM 调 browser mode=attach 首次触发」→ connecting → connect → connected；「LLM 调 disconnect」→ disconnected |
| §3.2 迁移表「app 重启（intent=on）」 | 启动 connecting + 自动 reconnect | 启动 disconnected（switch UI=on）；不 connect |
| §3.3 重连策略 | bootstrap 一次性 connect | **删除 bootstrap connect**；bootstrap 仅读 intent 恢复 UI 态；lazy connect 由 tool.run 触发 |
| §5 ConnectorManager | `enable()` 内部 tryConnect；`bootstrap()` reconnect | `enable()` 只写持久化 + 更新 UI；新增 `connectForToolRun(sessionId)`（含单例 owner）+ `disconnect(sessionId)`；`bootstrap()` 不 connect |
| §6 attach 门禁 | connectorManager.isReady 判定 | 门禁分层：① switch=off → 拒（未启用）② switch=on 但未 connected 且 owner 非本 session 且已被占 → 拒（占用冲突）③ switch=on 未连接且未被占 → **触发 lazy connect** |

### 6.2 `specs/tech/agent/tools/[P1]browser_tool.md`

| 段落 | 当前描述 | v0.0.46 后应改为 |
|---|---|---|
| §4「前置门禁」小注 + §7 `browserTool.run` mode==='attach' 分支 | 只复用 ConnectorManager 已建立的 session；未 ready 直接返错 | 未 connected 时**触发 lazy connect**（若 switch=on 且未被占）；被占返 ToolError；成功后走 dispatch |
| tool inputSchema | action 未列 disconnect | action 增加 `'disconnect'`（仅 mode='attach' 有效；其他 mode 传 disconnect 应报参数错误） |
| §4.1 治理动作 | 现有 3 项（判据真实化 / 失败清理 / 默认 autoConnect） | 保留（不改 driver 层）；本版本只改「谁触发 connect + 何时触发」，driver 契约不变 |
| §7 dispatch 表 | listPages/selectPage/navigate/... | 增加 `disconnect` → 调 ConnectorManager.disconnect(sessionId) |

### 6.3 `specs/ui/overall/05-connectors.md`

| 段落 | 当前描述 | v0.0.46 后应改为 |
|---|---|---|
| §3 交互表 | disconnected 文本「未连接」；点 toggle on → connecting | disconnected 分「未启用」（switch=off）/「已启用（未连接）」（switch=on）；点 toggle on 只翻 UI + 持久化，不进 connecting |
| §3 附注 | 刷新/重启后：intent=on → 进 connecting 自动重连 | 刷新/重启后：intent=on → switch UI=on + connection=disconnected（待 LLM 调 attach 才连） |

### 6.4 `specs/prd/overall/07-web-tools.md` §7.2.4

架构阶段由 doc-modifier 在 v0.0.46 阶段 5 同步：§7.2.4.2 状态迁移表所有「立即触发 connect」表述改为「lazy on tool.run」；路径表 H/J 描述调整；新增路径 P4（占用冲突）P8（lazy 失败）。

---

## 7. 非目标 / 边界

**OUT（v0.0.46 明确排除）**：

| 排除项 | 理由 |
|---|---|
| 修改 chrome-devtools-mcp 底层（`--autoConnect` 副作用根治） | 需 upstream flag 支持「connect-only 不 launch」；本版仅改触发时机，driver 参数不变 |
| 自动重连循环 / 断线自动恢复 | 沿用 v0.0.34「失败即停」，新增 lazy connect 也遵守此原则；周期探测/退避重连仍为后续 enhancement |
| mode ①② headless / managed-profile 的时机改动 | 无关——它们不经连接器；本版仅 mode ③ attach |
| 多用户 / 远程 attach 支持 | 单机本地单用户假设不变；全局单例约束在此假设下够用 |
| 占用冲突的 UI 通知 / 队列排队 | 用户明确决策：仅通过 tool result 报错传达给 LLM，不弹 UI；不排队，先到先得 + 显式 disconnect 释放 |

---

## 8. 验收标准（UT + 手工冒烟）

### 8.1 功能可观测节点

- **P1 UT**：`ConnectorManager.enable('browser')` 后 `getState()` = `{switch:'on', connection:'disconnected'}`；持久化 record `enabled=true`；**未调用** `driver.connect`。
- **P2 UT**：mock driver 情况下 `browser({mode:'attach', action:'listPages'})` 首次调用触发 `driver.connect` 一次；ConnectorManager 记录 owner；后续同 session 调用不再 connect。
- **P3 UT**：`browser({mode:'attach', action:'disconnect'})` 调用 `driver.disconnect` 一次；state connection=disconnected；owner 清空；返回 `isError:false`。
- **P4 UT**：owner=A 情况下模拟 sessionB 调 attach → 返回 `isError:true`，text 含「已被其他会话占用」；**未** 调用 driver.connect。
- **P5 UT**：`ConnectorManager.bootstrap()` 在持久化 `enabled=true` 时**不调用** `driver.connect`；state = `{switch:'on', connection:'disconnected'}`。
- **P6 UT**：switch=off 调 attach → `isError:true` 引导错误；未调用 driver.connect。
- **P7 UT**：模拟 session 结束回调（onSessionEnd）→ 若 owner=该 session 则调 `driver.disconnect`。
- **P8 UT**：mock driver.connect 抛错 → state connection=error + errorDetail 记录；owner 未写入；返回 ToolError。

### 8.2 错误回归防线（手工冒烟 checklist）

- [ ] app 启动**不再**弹「有应用要调试」系统 prompt（chrome 系）
- [ ] 启动日志中**不再** spawn chrome-devtools-mcp（除非当次真的调用了 attach）
- [ ] toggle on 后再关 app，不留孤儿 chrome-devtools-mcp / 空 chrome 进程
- [ ] 多 session 并发时，第二个 session 调 attach 立即报错，不 hang、不重试

---

## 9. 版本

version: 1.0 `[v0.0.46.connector_opt]`（新增：将 attach connect 时机从 bootstrap 立即触发改为 tool.run lazy 触发；switch 退化为纯功能开关；新增 disconnect action；attach 资源全局唯一 + 占用冲突 ToolError；根治 app 启动「有应用要调试」prompt 副作用）。overall 同步在 v0.0.46 阶段 5 由 doc-modifier 完成（§7.2.4 触发时机全表 + 路径表 P1-P8）。
