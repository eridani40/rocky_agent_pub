# v0.0.216 API 变更日志 — chat 区域统一复用（chat_unify）

> 架构阶段产出（architect）；实现后 coder 细化、doc-modifier 收口。

## 1. 新增接口

### GET /session/:id/chrome（会话装饰同构接口）

- 权威契约：`specs/api/overall/04a-session-chrome.md`（响应 shape / kind 数据源映射表 / capabilities 静态表 / 降级规则）。
- 动因：7 处 chat 消费方装配层各自拼 chrome（GET /session + GET /squad 两跳、academy 前端透传 classroom.defaultModel、playground useModelRestore 回填），统一收敛为一跳同构接口；能力差异（群聊关 run 态两 picker、academy 全开、subagent 只读）由后端 capabilities 静态表表达，前端零 kind 分支。
- 同构承诺：所有 kind 同一字段集，差异只在字段值。
- 路由：`routes/router-helpers.ts.matchSessionPath()` sub 枚举 + `routes/session-routes.ts` 分发 → `handlers/session-chrome.ts` → `services/session-chrome.ts.buildSessionChrome()`。

## 2. 行为修正（无接口 shape 变更）

- **运行时模型解析补 academy 分支**（存量 gap）：`services/model-resolver.ts` `sessionType` 扩 `'academy'`，fallback 链 = session → classroom.defaultModel → app_config.default_models.chat（与创建链 `academy-session-model.ts` 等价）。影响 POST /session/:id/messages、/compact 等运行时 resolve 路径下 academy 会话的实际用模；`MODEL_NOT_CONFIGURED` 错误体 `detail.sessionType` 值域加 `'academy'`。

## 3. 不变

- Session CRUD / PUT /session/:id 写路径（model/effort/approvalMode）零变更。
- SSE topic / 事件 shape 零变更（本版无新 topic）。
