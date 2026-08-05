# v0.0.46.connector_opt — 跨版本发布说明（tech 侧）

> 版本类型：**内部时机重构**（用户可感知：app 启动不再弹「有应用要调试」；LLM 视角新增 `disconnect` action）
> PRD 增量：`specs/prd/version_logs/v0.0.46.connector_opt/change_log.md`
> 架构：`states/v0.0.46.connector_opt/design.md`
> 测试范围：**仅 UT**（用户明确豁免 API/E2E test）

---

## 1. 变更 KB 一览

| KB | 文件 | 版本 | 变更摘要 |
|---|---|---|---|
| **config** | `[P1]connectors.md` | 1.1 → 1.2 | connect 时机重构：bootstrap/toggle 不 connect；tool.run lazy connect；owner sessionId + 全局单例；连接器 switch/connection 完全解耦；ConnectorManager 新增 `connectForToolRun`/`disconnect` |
| **config** | `index.md` | frontmatter updated | ④ 核心设计原则加 #7「lazy connect + 全局单例 owner」；⑤ 导航 connectors 一句话更新 |
| **config** | `log.md` | append | 2026-07-15 v0.0.46.connector_opt 变更记录 |
| **agent/tools** | `[P1]browser_tool.md` | v1.4 → v1.4/§4 §7 更新 | §4 前置门禁改写为 lazy connect 门禁分层三态；§7 tool 层示例更新（`action='disconnect'` 分支 + `connectForToolRun` 调用替换 `getAttachSession/isReady`）；`inputSchema.action` 增加 `disconnect` 枚举 |
| **agent/tools** | `index.md` | frontmatter updated | ⑤ 导航 browser_tool 一句话补 v0.0.46 disconnect action + 门禁分层 |
| **agent/tools** | `log.md` | append | 2026-07-15 v0.0.46.connector_opt 变更记录 |

driver 层（chrome-devtools-mcp `--autoConnect`、list_pages round-trip 判据、失败即停）**不改**——本版本只改「谁触发 connect / 何时触发 / 触发前判定」。

## 2. 影响范围

### 2.1 用户可感知
- app 启动**不再**弹「有应用要调试」系统 prompt（chrome 系）——bootstrap 不 spawn chrome-devtools-mcp
- 连接器页 toggle on 后不再进 `connecting` 态，status 显「已启用（未连接）」（灰点）
- guide 副标题：从「打开开关即连接」改为「打开开关启用后，agent 首次使用 browser 时会连接」

### 2.2 LLM 可见
- `browser` tool `inputSchema.action` 枚举**新增** `'disconnect'`（仅 mode=attach 有效）
- attach 门禁错误分层三态：`not_enabled` / `in_use_by_other` / `connect_failed`（原「未连接」错误退役）
- 多 session 并发调 attach 时，非 owner 会收到 `in_use_by_other` ToolError（不排队、不 UI 通知）

### 2.3 HTTP 契约
- `GET /config/connectors` / `PUT /config/connectors/:id` 端点契约本身**零变化**
- `ConnectorState.switch` 语义调整为 feature flag（与 connection 完全解耦）
- `PUT enable=true` 只写 intent + UI 态，不再触发 async connect（保留 202 兼容）

## 3. 关键设计决策

1. **switch = feature flag，与 connection 完全解耦**：把 v0.0.34 的「switch=on 即立即 connect 意图」改为「switch=on 仅表示用户已启用此功能」——connect 时机由「实际使用需求」触发。
2. **Lazy connect on tool.run**：`ConnectorManager.connectForToolRun(sessionId)` 在 LLM 首次调 `browser({mode:'attach'})` 时触发；成功记 owner=sessionId + 缓存 attachSession。
3. **owner=sessionId 粒度全局单例**：整个 app 内至多一个 attach session；同 owner 复用；不同 owner 触发 `in_use_by_other` ToolError（不排队、不通过 UI 通知）。
4. **门禁分层三态由 tool result 传达**：`not_enabled`（引导开开关）/ `in_use_by_other`（引导 owner session 先 disconnect）/ `connect_failed`（详情） —— 全部由 tool 层 `formatConnectorError` 转 ToolResultBlock，UI 不弹 toast/modal。
5. **显式 disconnect action**：LLM 在 attach 任务收尾时可主动 `browser({mode:'attach', action:'disconnect'})`（idempotent）；session DELETE / agent idle 兜底自动 disconnect（仅 owner=endedSid 才真断）。
6. **失败即停仍生效**：lazy connect 失败 → connection=error + owner 未写入，**不重试循环**（沿用 v0.0.34 BUG-009 收敛）。
7. **driver 层零改动**：chrome-devtools-mcp 参数、list_pages 判据、SSRF 边界全不变——本版本纯粹是「谁触发 + 何时触发 + 触发前判定」的时机重构。

## 4. 验收结论

- 所有 3 task verified（UT 覆盖 P1-P8 + I/J/K）
- code review：全部 PASSED / CONDITIONAL PASS
- API/E2E test：用户明确豁免（内部时机重构，无对外契约破坏性变化）
- doc-modifier 阶段 5 已同步：tech（config/agent-tools index+log）+ prd/api overall + ui overall + connector-page 组件 spec

## 5. 兼容性

- **HTTP 端点契约零变化**：既有 UI 客户端无需改动即可运行（switch UI 语义描述改动，但字段本身不变）
- **browser tool schema 加 `disconnect`**：LLM prompt 生成的 tool call 若不含 disconnect 完全兼容；已在 tool inputSchema 声明枚举扩展
- **ConnectorManager 接口新增方法**：`connectForToolRun` / `disconnect(sessionId?)` 为新增；`enable`/`bootstrap` 保留但语义调整为「不再触发 connect」——依赖它们「触发 connect」的老代码需改走 `connectForToolRun`（本版本已同步 browser tool 层）
