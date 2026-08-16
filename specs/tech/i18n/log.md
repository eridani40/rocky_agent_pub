---
type: log
title: i18n KB 变更记录
updated: 2026-08-15
---

## 2026-08-15 · v0.0.357（picker 默认语义方案态 chat ns 新增 1 leaf）

- **chat ns 新增 `planDefaultLabel`**：zh `方案 · {{name}}（默认）` / en `Plan · {{name}} (default)`——picker hover/菜单方案态默认项 label（`component-input-model-picker`，数据源 chrome `defaultRoutingPlan`）。
- **收敛注记**：picker 旧「未配置」「（默认）」仍为硬编码中文（change_plan D4 可选收敛项未启用，本版只做必做新增）；后续动 picker 文案时再评估收敛。
- 发布说明：`specs/tech/version_logs/v0.0.357/change_log.md` 修复 A。

## 2026-07-08 · v0.0.89（locale group 合并入 appearance — read-modify-write）

- **`[P0]i18n_overview.md §5.2/§5.4/§6`**：locale group 合并入 `appearance` group（与 theme 同组），`language` 作为 appearance 的一个 key。
  - `initI18nFromConfig`：GET URL 从 `?group=locale&key=language` 改 `?group=appearance&key=language`（fallback zh-CN 不变）。
  - `changeLanguage`：从 `PUT ?group=locale items:[{key:'language', data:lng}]` 改 **read-modify-write appearance 整组**（先 GET appearance → filter 掉 language → 拼新 language → PUT 整组含 theme+language 两 key）；避免 PUT 整组时覆盖 theme。切即生效保持（不走 page-tab dirty，design-brief §1.2 硬约束）。
  - §6 链路总结改：`app_config.appearance.language`（替代旧 `app_config.locale.language`）。
- **数据迁移**：`scripts/migrate-dev-to-app.v0.0.89.sh` 重写 locale group 名为 appearance（保 id+key+data）；旧 `{group:"locale", key:"language"}` record 改为 `{group:"appearance", key:"language"}`。
- **代码落点（T4 已 verified）**：`app/web/src/i18n/change-language.ts` GET appearance → 保留 theme → 合并 language → PUT 整组（含 theme+language 两 key）；`app/web/src/lib/locale-init.ts` GET 改 `?group=appearance&key=language`；`component-locale-card.tsx` onChange 调 changeLanguage（独立 PUT appearance，不进 page-tab dirty 流），testid 改 `key-card-language` / `key-select-language`（原 `key-card-locale-language` 简化）。

详情：`specs/tech/version_logs/v0.0.89/change_log.md`

## 2026-08-15 · v0.0.356（squad member 余额查询弹层 chat ns 扩展）

- **chat ns 新增 26 leaf**：`floatMenu.quota`（余额查询）+ `quotaModal.*`（弹层标题/方案/图例/档位/时间/状态/脚注）。key 命名按 `[P0]i18n_overview.md §4` `<ns>.<scope>.<leaf>` 骆驼命名，zh-CN/en 同构，零硬编码中文。
- **关键 key**：状态词四态 `legendWorking/legendOpen/legendHalf/legendOff`、档位 `tierFiveHour/tierWeekly/tierBalance`、单单位分支 `singleUnitDay/Hour/Minute/Zero`、时间条件 `timeAny/timeHit/timeMiss`、熔断 `retryIn`、半开 `halfProbing`、脚注 `lastUpdated/refreshHint`。
- **使用方式**：`component-chat-float-menu` aria-label、`component-quota-entry-modal` 弹层文案、`component-quota-provider-card` 收起/展开态文案、`component-quota-ring` aria-label 由父级传入、`quota-format.formatSingleUnit` 接收 `SingleUnitLabels` i18n 驱动。
- 跨版本发布说明：`specs/prd/version_logs/v0.0.356-squad-quota-entry/change_log.md` §6。

## 2026-07-04 · v0.0.62.i18n_migration（thin 架构 — 机械迁移到 v0.0.59 架构，无机制变更）

**版本定位**：本版本是机械迁移——填实 8 ns + common locale bundle + 替换 `t()` 调用 + 配置体系预设/type code + 内置 plugin label 前端映射。**不搭新机制、不引入新概念**。架构产出 thin：大部分只引用 v0.0.59 KB 章节，仅澄清涉及契约的两个点（M3 session 默认占位 / M4 HTTP 错误）。

**引用的 v0.0.59 KB 章节**（本版本不重设计，纯引用）：
- KKV 占位符四规则 + 兜底链 + 缺 key 报错 → `[P0]i18n_overview.md §3`
- bundle 物理结构 + 10 ns 划分 + key 命名 `<ns>.<scope>.<leaf>` camelCase → `[P0]i18n_overview.md §4`
- locale 开关 `app_config.locale.language` + 启动期 init + 切实时生效 → `[P0]i18n_overview.md §5`
- type-vs-动态文本判定流程（type 走映射 / 自由文本走直展）→ `[P0]i18n_overview.md §7`
- displayReason 后端范式契约（零 API breakage）→ `[P0]i18n_overview.md §8`

**本版本补充的范式**（概念先行，落 KB 不在 PRD）：
- `index.md §⑥ type code 跨版本累积映射表`：把 v0.0.59 §7 的「首批覆盖（errorCategory 单例）」抽象为通用范式 `<ns>.<entity>.<field>.<code>`，并列出本版本扩展的 5 个 type code family（Run.stopReason / session.state / member.role / member.state / connector.connection）+ 1 个后端 sample pattern（session default title）。**这不是新机制**——是 §7 type→mapping 范式的实例累积；本版本的所有 type code 映射 key 命名（见 PRD §2.1 M3 + backlog A2/A5）均回溯此表。**[doc-modifier 实测]** 实现期间又补 4 类（taskStatus / reqStatus / autoWorkReason / autoWorkResult，T3/T6 漏盘点回填），累积表已扩到 9 行——见本条目末「实现层落地核实」段。

**契约细化点（M3 / M4）**：

1. **M3 session 默认占位（A1）**：后端 `app/server/src/handlers/session.ts:134` 当前 `body.title ?? '新会话'` 字面返回中文「新会话」。**发现已有契约 `Session.titled: boolean`（v0.0.47 新增，`04-agent-session.md §1 line 57`）**：`false` = title 仍是默认占位，`true` = 已被命名（人工/AI）。本版本采用「`titled` 字段为信号、`title` 字面保留」方案（**零 API breakage，复用 displayReason §8 同款「后端发 data+signal、前端查表」范式**）：
   - 后端契约不变：`title` 仍字面返回「新会话」（zh-CN 兜底，向后兼容旧 caller），`titled` 字段不变
   - 前端行为：`session.titled === false ? t('chat.session.defaultTitle') : session.title`（titled=true 时直展，属用户数据硬边界不翻译）
   - **不引入 title=null sentinel**（会破坏现有 `title: string` 类型契约 + 所有现有 caller）
   - 已在 `specs/api/overall/04-agent-session.md §1` Session interface 处补注释说明 title+titled 的 i18n 渲染责任在前端。

2. **M4 HTTP 错误体 i18n — spec/PRD 漂移修正（重要，需 orchestrator 转用户）**：PRD §2.1 M4 写「保留机器可读 `code` 字段不变」**与现状不符**——核查全部 handler（`session.ts` / `squad.ts` / `skill.ts` / `02-llm-chat.md` / `06-skill.md`）后确认：**当前 HTTP 错误体只有 `{ error: "<自由文本 msg>" }`，从未存在机器可读 `code` 字段**（部分端点附加 `detail`，但无 `code`）。PRD M4 把两个独立的「code」概念混了：
   - SSE/chat 域的 `errorCategory`（LlmErrorCategory 18 codes，在 `RunErrorInfo` 内）+ `Run.stopReason`（7 codes，run_end 事件）—— 已是 type code 走映射，本版本 M3 已覆盖（`error.llm.*` + `chat.run.stopReason.*`）
   - HTTP 错误响应体（4xx/5xx 的 `{ error: msg }`）—— 是**自由文本**，按 v0.0.59 KB §2.2 硬边界原样直展不翻译
   - **本版本 M4 实际范围（与 v0.0.59 KB §2.2 硬边界对齐，zero API breakage）**：HTTP 错误体 `{ error: msg }` **保持不变**，归为「动态自由文本」原样直展；前端不查表、不翻译。如未来确需本地化 HTTP 错误消息，**必须新引入 `code` 字段**（新机制，扩 v0.0.59 KB §2.2 硬边界），与本版本「机械迁移、不变机制」原则冲突 → **不在本版本范围**。M4 在本版本实质降级为「无变更（仅澄清边界）」，相关任务 T7 可取消或合并入 M3 type code 范围（`stopReason` 已覆盖 chat 域 type code）。

**StopReason 7 值（不是 PRD §3 UC-4 暗示的 6 值）**：`agent-event-types.ts:32-39` 实测：`no_tool_call | no_new_messages | max_iterations | doom_loop | error | require_approval | interrupted`（7 个）。前端 `component-run-finish.tsx:34` 的 `REASON_TEXT` 表覆盖 6 个（`error` 走 `error.displayReason` 动态文案，不进表）。本版本迁移保持同一结构：`chat.run.stopReason.{noToolCall, noNewMessages, maxIterations, doomLoop, requireApproval, interrupted}` × 6 leaf；`error` 仍走 `RunErrorInfo.displayReason` + §8 范式（已是 v0.0.59 error.json 18 leaf 覆盖）。

**ConnectorConnection 4 值（不是 backlog A5 暗示的 5 值）**：`api-client.ts:732` 实测：`'disconnected' | 'connecting' | 'connected' | 'error'`（4 个）。本版本映射 `connector.browser.connection.{disconnected, connecting, connected, error}` × 4 leaf。

**type code 映射 locale key 清单（M3 A2 子集）**——见 `index.md §⑥` 累积表。

**M5 方案变更（架构修正，需 orchestrator 转用户）**：M5 内置 plugin 文案 i18n 方案，原 architect 结论「纯前端按 plugin id 映射、manifest 不改」**改为**「manifest 占位符改造 + 前端 locale 翻译 + `resolveI18nField` helper」。理由（用户在「架构合理性」层质疑成功）：
- 原方案硬伤 1：**前端凭空生成 plugin 语义文案** —— 前端按 plugin id 映射表「出」label/desc，但 manifest 才是 plugin 语义文案的权威源，前端不该兜底生成。
- 原方案硬伤 2：**新增 ext impl 不同步** —— 新加 ext impl 时前端映射表若漏填，静默显示 manifest 字面中文，无强制报错机制。
- 新方案对齐业界标准（WebExtension `__MSG_` MDN/W3C + react-i18next「backend returns keys」官方推荐）+ 解决单一数据源（占位符 key 在 manifest 声明）+ 解决强制同步（缺 key 报错）。

**配套 §3 line 51 修订**：原「后端**永远不直接返回 i18n key 字符串**」过于绝对，修订为两类区分：
- ❌ 运行时动态数据不当 key（保留原禁令本意，防 raw key 漏迁移事故）
- ✅ 产品代码声明占位符 key 允许（放开：manifest 等产品代码静态字段可用 `__MSG_<key>__` 占位符）

**新增 §3.1 manifest 占位符协议**（v0.0.62+）：
- 语法：`__MSG_<dotted.key>__`（融合 WebExtension 业界标准 + v0.0.59 点路径 key 命名）
- 适用：manifest 等产品代码静态字段（builtin plugin 文案）
- 不适用：运行时动态数据（走原 §3 字面直展规则）
- 字段格式不变：description 仍是 `string`，只改值（字面 → 占位符），向后兼容老/第三方 plugin
- 后端零改：inventory 透传 string 不变（符合 §6 后端不 locale）
- 新增 §3.1.1 `resolveI18nField(value, t)` helper 契约：`__MSG_` → `t()`，否则直展；missing key 走规则 (4) 报错不 fallback 原文（强制同步保障）

**M5 工作量重估**（替换原「纯前端中工作量」结论，约 1 个 task）：
- manifest 改造：3 个 builtin plugin × (label/desc + extImpl desc + schemaConfig desc) ≈ ~64 处文案 → `__MSG_` 占位符
- locale 填充：`app/web/src/i18n/locales/{zh-CN,en}/plugin-config.json` ~128 keys
- helper：`resolveI18nField` 1 个通用函数 + UT（占位符识别 / missing key 报错 / 字面直展 fallback 三类 case）
- 渲染接入：4 个组件（plugin-item / ext-impl-{radio,checkbox,ordered} / schema-config-modal）改用 helper
- 后端零改（inventory 透传 string 不变，符合 §6）

**[P0]i18n_overview.md 文件超长处理（拆独立 KB 方案 b）**：原 §3.1 子节（manifest 占位符协议 + helper 契约）致 [P0] 从 293 行 → 339 行（超 300 硬限 39 行）。已采方案 (b)：**§3.1 详细内容拆到独立 KB `[P1]manifest_i18n.md`**（v0.0.62+ manifest i18n 协议 + helper 契约），[P0] §3.1 处仅保留一句引用指向 [P1]，[P0] §3 line 51 两类区分修订（动态数据禁令 / 产品代码声明放开）仍保留在 [P0]。拆分后 [P0]=297 行 / [P1]=146 行，均 ≤ 300 硬限。

**文件变更清单（v0.0.62 i18n 架构层）**：

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `specs/tech/i18n/[P0]i18n_overview.md` | 修改 | §3 line 51 修订「永远不返回 key」→「两类区分」（保留动态数据禁令 + 放开产品代码占位符声明）；§3.1 详细内容拆出（见下条），原位置改为引用指向 [P1] |
| `specs/tech/i18n/[P1]manifest_i18n.md` | 新增 | manifest 占位符协议（语法/适用/不适用/字段格式不变/后端零改/单一数据源/强制同步）+ resolveI18nField helper 契约（签名/逻辑/missing key 不 fallback/通用性/落点/UT 覆盖）+ rocky_context 改造前后对比示例 + 文件变更清单（[P0] §3 在 manifest 场景的扩展协议） |
| `specs/tech/i18n/index.md` | 修改 | §⑤ 本目录导航注册 [P1]manifest_i18n.md（P1，manifest 占位符协议一句话简介） |
| `specs/tech/i18n/log.md` | 修改 | v0.0.62 条目追加 M5 方案变更记录（原方案硬伤 + 新方案业界标准 + §3 修订摘要 + 工作量重估 + §3.1 拆分到 [P1]manifest_i18n.md） |

**无 v0.0.59 KB 机制变更**（arch_unchanged 不变量守住）：KKV/兜底链/缺key报错/locale 开关/bundle 结构/key 命名/type→mapping 范式/displayReason 契约全不改。§3 line 51 修订是**精化**（原「永远不」过于绝对）非推翻原机制；§6（后端不 locale）/ §7（type 映射）保持不动。

**实现层落地核实（doc-modifier 阶段5 实测）**：
- **9 ns locale bundle 全填实**（zh-CN+en keys 严格对齐）：chat 129 / studio 156 / providers 37 / plugin-config 106 / app-dev-config 54 / skill 32 / connector 19 / framework 7 / common 40 leaf。+ error ns 18 leaf（v0.0.59 已落）。
- **type code 通用 helper**（v0.0.62 落地）：`app/web/src/i18n/code-key.ts` 抽出 `camelCaseCode()` + `localizedCode()` 通用范式（snake_case + kebab-case 兼容），重构 5 处重复实现（`stop-reason.ts` / `llm-error-category.ts` / `board-view.tsx` / `auto-work-history.tsx` 内 statusLeaf/resultLeaf 内联）；新增 type code family 实测扩展到 9 类（含 `Board.taskStatus` / `Board.reqStatus` / `AutoWork.reason` / `AutoWork.result`，见 `index.md §⑥` 表更新）。
- **§⑥ 表新增 4 行**（实测 T3/T6 落地范围超出 architect 草案）：taskStatus/reqStatus（5 code 各）/ autoWorkReason（2 code）/ autoWorkResult（5 code）—— 均走同款 code-key.ts helper 范式（snake/kebab→camel 查表）。
- **role/memberState 决策（T6 reviewer 决定）**：领域术语保留字面英文（leader/mate/deployed/benched）不查表，bundle 仍落对应 leaf 以备将来扩展（保留扩展点 + 减少 spec/code 漂移）。§⑥ 表对应行已标「保留字面英文，不查表」。
- **sessionState 暂无 consumer（T6 reviewer 备注）**：5 leaf 已落 common.json，但当前无组件消费（session state 由 status icon 表达，不是文本）；保留 leaf 备扩展。
- **`resolveI18nField` helper 落地**：`app/web/src/i18n/resolve-i18n-field.ts`（56 行）实现 §4 契约 + UT 三类 case；6 个组件接入（plugin-item / ext-impl-{radio,checkbox,ordered} / schema-config-modal / **section-ext-point-area** for EP description）—— 比原 spec §4 多 1 个（section-ext-point-area 是 BUG-002 修复时补的，EP description 也走占位符协议）。
- **manifest 占位符落地范围（实测）**：3 builtin plugin.json × 67 占位符（label/description/extImpls[].description）+ 12 EP description（extension-point.ts）+ ~14 schemaConfig description；plugin-config.json 106 leaf 覆盖全部。
- **BUG-001 修复（T6 块B）**：`session.ts:139-150` POST /session with body.title 路径补 `updateSession(id, { titled: true })`（对齐 PUT:185-193 同款 CAS gate）；零 API breakage（POST 201 响应形状不变，仅 titled 字段从 lazy false 变 true）。
- **BUG-002 修复（AT 阶段）**：12 EP description（extension-point.ts）从字面中文 → `__MSG_extpoint.<id>.description__` + section-ext-point-area 接 resolveI18nField；plugin-config.json +12 keys（106 leaf 总数已含）。

**跨版本发布说明**：`specs/tech/version_logs/v0.0.62.i18n_migration/change_log.md`（doc-modifier 阶段 5 落地）。



# i18n KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-04 · v0.0.59.i18n（实现完成 + AT 2/2 pass + spec 偏差回填）

- **T1-T4 全部 verified**：i18n 基础设施（`i18n/index.ts` + `lib/locale-init.ts` + `main.tsx` await init）+ locale 选择器（`component-locale-card.tsx`）+ change-language 实时切+持久化 + displayReason 范式（`llm-error-category.ts::localizedDisplayReason` 查表回退）。
- **AT 2/2 pass**：覆盖 locale 读写 + displayReason 契约（errorCategory code 不变 + zh-CN 兜底）。
- **ET**：用户自测（executor skip），case 在 `tests/e2e/i18n/`。
- **displayReason 18 keys**（spec 偏差回填，原则 12/13）：实测前后端 `DISPLAY_REASON_TABLE` 均为 **18 keys**（不是此前 spec 写的 19）。前端 `error.json` zh-CN/en 各 18 leaf 与后端 18 行映射一一对应。修正本 KB `[P0]i18n_overview.md` 多处「19」→「18」+ §8 JSON 删除重复的 `maxTokensTooHigh` 行。
- **testid 同步 page-app-settings**（spec 内部不一致回填）：§9 挂载点 testid 修正为 `page-app-settings`（对齐 v0.0.47 设置页合并重构 + `03-config-center.md §2.2 [v0.0.59 corrected]`，原 spec 误写 `page-app-config`）。
- **fallbackNS 偏差回填**：react-i18next v15 数组 ns **不自动跨 ns fallback**（需 init 配 `fallbackNS`，本版本未设）。修正 §5.3 表述：跨 ns 取值用 `t(key, { ns: 'common' })` 显式 或 `t('common:key')` 前缀；`fallbackNS` 列为后续优化项（不在本版本）。
- **GET /session/:id currentRun.error 契约澄清**（配套修 `02-llm-chat.md §1` + `04-agent-session.md §10 路径 C`）：`currentRun.error` 仅在 `state=running` 且 `currentRunId≠null` 时存在；`state=error` + eager-drain（currentRunId=null）时响应**无 currentRun/error 字段**，error 信息读 SSE error 事件或 history run（RunRecord）。
- 跨版本发布说明：`specs/tech/version_logs/v0.0.59.i18n/change_log.md`。

## 2026-07-03 · v0.0.59.i18n（i18n 基础设施首版 spec 创建）

- 新建 KB：`index.md`（5 章总起 + 7 条核心设计原则）+ 本 `log.md` + `[P0]i18n_overview.md`（KKV 协议 / bundle 结构 / react-i18next 集成 / locale 开关链路 / type 渲染判定 / displayReason 契约）。
- **概念落点**：i18n 是新概念，本 KB 是项目内 i18n 的**概念权威源**——后续 PRD/api/ui 引用 i18n 时均回溯本 KB（concept-first 原则）。
- **核心决策**：
  1. KKV 占位符协议 + 四规则（字面直展 / key 查 KKV / 兜底链 当前→en→zh-CN / 全缺报错）。
  2. bundle 按 page 模块拆 ns（chat / studio / providers / plugin-config / app-dev-config / skill / connector / framework / common / error）。
  3. key 命名：dot.notation + camelCase leaf（`<ns>.<scope>.<leaf>`）。
  4. react-i18next init：build-time import resources + lng from app_config + fallbackLng=['en','zh-CN'] + parseMissingKeyHandler 报「资源 xxx 不存在」；启动期 `await initI18nFromConfig()`（对齐 theme-init BUG-001 范式）。
  5. **后端本版本不需要 locale**——displayReason 范式 = 后端发 code、前端查表，后端透明；后端产生本地化文案是未来扩展点。
  6. **type 走映射、动态文本走直展**——可枚举 type 查 `error.llm.<code>`，自由文本（error_message / 用户数据 / LLM 回复）原样直展。
  7. **displayReason 零 API breakage**——契约不变，前端启用 i18n 后前端侧按 errorCategory 查 locale 表、查不到回退 displayReason 字段。
- **跨 KB 协同**：
  - `specs/tech/config/[P0]app_config.md §3.3` locale group 复用（不新增 group，读写经 `AppConfigService.get/set("locale", "language")`）。
  - `specs/api/overall/02-llm-chat.md` v0.0.59 段：displayReason 契约「字段不变、前端侧改用 errorCategory 查 locale 表」说明（向后兼容）。
  - `specs/ui/overall/03-config-center.md` v0.0.59 段：设置页 locale group 加语言选择器（`primitive-key-choice-cards`，禁原生 select per `_conventions §10`）。
  - `specs/tech/app/frontend/[P0]tech_stack.md` v0.0.59 段：新增依赖 react-i18next + i18next；§4.1 package.json 片段加注释说明。
- 实现层（task）：`app/web/package.json` 加 `i18next` + `react-i18next` 依赖；`app/web/src/i18n/index.ts` 新建（init + changeLanguage + 导出 hook）；`app/web/src/i18n/locales/{zh-CN,en}/*.json` 新建（10 ns × 2 语言 = 20 文件，本版本仅 error.json 实质覆盖 19 category，其他 ns 起骨架）；`app/web/src/lib/locale-init.ts` 新建（对齐 `theme-init.ts` 范式）；`app/web/src/main.tsx` 修改（启动期 await initI18nFromConfig + I18nextProvider 包裹）；`app/web/src/components/app-dev-config-page/*` 修改（locale group 加 key-card-language 选择器）；`app/web/src/components/chat/*` 等首批迁移走 Batch 2（不在本版本）。

详情：`specs/tech/version_logs/v0.0.59.i18n/change_log.md`（待 doc-modifier 阶段 5 落地）
