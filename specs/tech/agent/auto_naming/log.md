---
type: log
title: Auto Naming KB 变更记录
updated: 2026-07-15
---

# Auto Naming KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-15 · v0.0.153（起名提示词正文文件化，NAMING_PROMPT → content/auto_naming.md）

- `auto-naming-service.ts` 的 `NAMING_PROMPT` 内联 TS 常量删除，正文迁移至 `app/server/src/prompts/content/auto_naming.md`（措辞逐字一致），经新增 `AutoNamingHandler`（`{{query}}` 占位符替换）读取；`applyAiName()` 调用点等价替换，`LlmCaller.invoke`/CAS/observability 逻辑零改动。
- `[P0]auto_naming_service.md §3/§4` + `index.md`（②边界/③关系图/④原则）同步更新为 handler-based 描述；通用机制归 `../context/[P0]prompt_content_files.md §4.2`（不重复维护）。
- 详情：`specs/tech/version_logs/v0.0.153/change_log.md`

## 2026-07-07 · v0.0.84 起名链路改走 LlmCaller.invoke（去 hardcode + reuse 重试 + langfuse 闭环）

- **背景**：起名裸调 `config.client.call` 绕过 `LlmCaller.invoke`（无 adaptive retry / 无 langfuse / 无错误归一化）+ hardcode `params:{maxTokens:1024,temperature:0}`（thinking 模型 thinking budget 截断 → `stop_reason:max_tokens` 无 text → 静默失败）+ gate 首条锁定（失败永久放弃，重启不恢复）。
- **D2/D3/D4 用户拍板**：D2 reuse `LlmCaller` adaptive retry 全套（`backgroundPath:true` 仅排除 capacity 防雪崩，不另搞跨消息补/应用层重试）/ D3 `baseReq` 完全不传 params 复用 session/model 配置 / D4 gate + CAS 保持现状（不补起名，失败由用户手动改名）。
- **D5 AT 中加固（observability 真源修复）**：起名 observability adapter **必须从 `AutoNamingServiceDeps.observability` 注入**（bootstrap 传 `observabilityManager`，与 AgentManager 同源），**绝不能用 `config.observability`**——根因：`resolveConfigBySid` 返的 SessionConfig 不含 observability 字段（只在 `AgentManager.activate` 主 run 路径注入），起名不走 activate → 误用致 langfuse 永远接不上（功能 pass 但无 trace）。AT round1 暴露坐实、round2 修复后真现 trace。
- **变更内容**（`[P0]auto_naming_service.md` 全面重写 + `auto-naming-service.ts` 实现）：
  - §1 模块边界：删「不引 LlmCaller 策略层」「单次 LlmClient.call」；加「走 LlmCaller.invoke（adaptive retry + langfuse 闭环）」「不裸调 config.client.call」「不 hardcode params」「独立 langfuse trace」。
  - §3 CAS 应用：代码改走 `LlmCaller.invoke(baseReq, ctx)`（`backgroundPath:true`，`baseReq.params:{}`），加 `startGeneration`/`observeFailure`/`endTrace`；删 v0.0.64 maxTokens=1024 注（D3 已退役）。
  - §4 NAMING_PROMPT 注：删 maxTokens/temperature 引用。
  - §5 错误矩阵：加 langfuse 观测列；加「观测本身 fail-silent」不变量；防回归守卫升级（加 langfuse trace 检查 + AT poll window ≥40s）。
  - 新 §6 langfuse 观测接线：§6.1 observability 真源 = deps 注入（**MUST** 不变量）+ §6.2 trace 命名约定（`name:'auto_naming'`，独立 trace 无父）+ §6.3 失败观测归一（endGenerationError by category）。
  - §8 接线清单：`AutoNamingServiceDeps` 加 `llmCaller` + `observability`；bootstrap 装配点同步。
- `index.md` §① 概念表「复用 LlmClient」→「走 LlmCaller.invoke」+ 新增「独立 langfuse trace」行；§③ ASCII 重写 applyAiName（LlmCaller.invoke + startGeneration + backgroundPath）；§④ 核心原则 #3 重写为「走 LlmCaller」+ 新增 #4「observability 真源 = deps 注入（不变量）」（原 #4–#7 顺延为 #5–#8）；§⑤ 导航行 + 关联链接加 llm_caller KB。
- frontmatter `updated` 2026-07-04 → 2026-07-07。
- **AT 验证结果**：basic + cas 2/2 pass（真 LLM + 真 langfuse）。basic case：起名功能 pass（title="Python快速排序实现" titled=true）+ langfuse oracle trace 真现（poll window 加长 40s 覆盖 SDK batch flush）。cas case：AI 名返回前用户改名 → CAS fail → AI 名丢弃 → 用户名保留。
- 跨版本发布说明：`specs/tech/version_logs/v0.0.84.auto_naming_fix/change_log.md`。

## 2026-07-04 · v0.0.64 修复 thinking 模型起名失效（maxTokens 32→1024）

- `[P0]auto_naming_service.md §3 / §4 / §5` + `auto-naming-service.ts`：修复 thinking 模型（deepseek-v4-pro）系统性不起名 bug——
  - **根因**：thinking 模型会先产出 thinking block，原 `maxTokens:32` 让 thinking 占满整个 token budget → `stop_reason:"max_tokens"` → 永远到不了 text 输出 → `extractPlainName` 找不到 TextBlock → 返 null → 不起名。非 thinking 模型（glm/minimax）实测 2-3 token end_turn 不受影响。
  - **修复**：`maxTokens: 32` → `maxTokens: 1024`（实测 deepseek ≥800 出 text，1024 兜底）。
  - §3 加「maxTokens=1024（thinking 模型需 ≥1024）」注；§4 设计意图同步；§5 错误矩阵「无 TextBlock」行标注 thinking 模型 + 小 maxTokens 会系统性触发（v0.0.47 设计时无 thinking 模型，v0.0.53 引入后回归无人察觉）；新增「防回归守卫」：新增 thinking 类 provider 须验证起名场景。
  - 实测对照（coder B 验证）：deepseek-v4-pro + maxTokens=32 → 只有 thinking block（失败）；=800/1500 → end_turn 有 text（成功）；=32 + thinking:{type:"disabled"} → 2 token 出 text（成功，方案 B 未采纳，协议层改动大留长期）。
- frontmatter `updated` 2026-07-02 → 2026-07-04。

## 2026-07-04 · v0.0.62 i18n（BUG-001 修复：POST /session body.title 路径补 titled=true）

- `[P0]auto_naming_service.md §6` + `index.md §②边界`：补「POST /session body.title 路径置 titled=true」条目（v0.0.47 漏 POST 路径，只覆盖了 PUT）。`session.ts:139-150` POST handler 在 `createSession` 之后调 `updateSession(id, { titled: true })`（CAS gate 翻 true），对齐同文件 PUT:185-193 行为。
- 修复动机：POST 时若用户传了 title 而 titled 缺省 false，AI 后续 auto-naming 会 CAS 误判「未命名」覆盖用户字面（v0.0.47 titled 信号本意，POST 路径此前漏写）。
- HTTP 契约不变（POST 201 响应形状不变，仅响应 body `titled` 字段从 lazy `false` 变实际值 `true`）。
- frontmatter `updated` 2026-07-02 → 2026-07-04。
- 跨版本发布说明：`specs/tech/version_logs/v0.0.62.i18n_migration/change_log.md`。

## 2026-07-02 · v0.0.47 doc-modifier 同步（drift 订正）

- `[P0]auto_naming_service.md §3 / §3.1 / §5`：对照最终代码（`auto-naming-service.ts`）订正 3 处 drift——
  - §3 CAS 应用：移除 `await metaBroadcaster.broadcast(sid)` 的 `await`（`SessionMetaBroadcaster.broadcast` 是同步 void，无 promise 可 await）。
  - §3.1 `extractPlainName`：`resp.content` → `resp.message.content`（CanonicalResponse shape）；单 regex `^["""'] +|["""']$/g` → 实际代码的 3 趟 regex（半角+全角 smart 引号 + CJK「」/『』 + 半角/全角单引号）；补 `![0]!.trim()` 非空断言。
  - §5 错误处理表：`metaBroadcaster.broadcast throw` 行改为「不会抛出——broadcast 同步 void 内部已 try/catch 吞异常」（与 session-meta-broadcaster.ts 实现一致）。
- 全部 frontmatter `updated` 2026-07-01 → 2026-07-02。

## 2026-07-01 · v0.0.47（auto_naming 新建 KB）

- 新建 `auto_naming/` KB（mini-KB）：`index.md`（5 章总起 + 7 条核心设计原则）+ `[P0]auto_naming_service.md`（触发 hook + CAS 应用 + NAMING_PROMPT + 静默失败 + 触发点接线）+ 本 `log.md`。
- 落地 PRD `specs/prd/version_logs/v0.0.47-ui_opt/change_log.md` §2.1「session 名字可编辑 + AI 起名」的 AI 起名侧（编辑态 conv-item 落 ui spec）。
- **关键决策（architect 定）**：
  - **titled 字段 lazy 默认 false（不跑 migration）**——`titled?: boolean` optional；首 query 触发条件（transcript 无 prior role=user）已天然保护现存 session（都有 prior user 消息）不被误触发，无需扫描存量数据置 true。对齐 bizType（v0.0.33.1）/ unread（v0.0.27）lazy 默认先例。
  - **触发点 = `handleMessagesPost`（session-messages.ts:107-187）**，userMsg 构造后、`deliverTo` 前/后并行触发（不 await）。
  - **应用条件 = CAS `titled===false`**——AI 名返回时 re-read session，仅当 titled 仍 false 才写 `{title, titled:true}` + 触发 `metaBroadcaster.broadcast(sid)`；否则丢弃。
  - **playground scope gate**：`bizType==='playground' && type!=='subagent'`。
  - **复用 LlmClient.call（非 stream）**：`resolveConfigBySid(sid).client.call({messages, params:{maxTokens:32, temperature:0}})` 单次调用；不引 LlmCaller 策略层；失败静默。
  - **PUT /session/:id body.title 路径置 titled=true**——手动改名也走 CAS gate（置 true 后 AI 名永不再覆盖）。PUT title 路径同时触发 `metaBroadcaster.broadcast(sid)`（v0.0.47 补强）。
