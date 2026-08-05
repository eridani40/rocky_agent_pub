# v0.0.62.i18n_migration 技术变更说明（i18n 迁移 Batch 2）

> version: 1.0 · 2026-07-04
> 一句话：机械迁移到 v0.0.59 i18n 架构——9 ns locale bundle 填实（580 leaf）+ 组件硬编码 → `t()` + 5 类 type code 查表 + manifest 占位符协议落地（builtin plugin + 内置 EP description）。**不改 v0.0.59 任何机制**。
> 概念权威源：`specs/tech/i18n/` KB（`index.md` + `[P0]i18n_overview.md` + `[P1]manifest_i18n.md` + `log.md`）。
> PRD：`specs/prd/version_logs/v0.0.62.i18n_migration.md`。

## 1. i18n KB 增量

不新建 KB（v0.0.59 已建），仅增量更新：

| 文件 | 操作 | 变更 |
|---|---|---|
| `index.md` | 修改 | §⑥ type code 累积表：v0.0.62 落地范围扩到 9 类（除 v0.0.59 `errorCategory` 外，加 `Run.stopReason` / `Session.state` / `Member.role` / `Member.state` / `Board.taskStatus` / `Board.reqStatus` / `AutoWork.reason` / `AutoWork.result` / `Connector.connection`）；role/memberState 标「保留字面英文，不查表」（领域术语决策，bundle 仍落 leaf 备扩展） |
| `[P0]i18n_overview.md` | 修改 | §3 line 51 修订「永远不返回 key」→「两类区分」（运行时动态数据禁令保留 + 产品代码声明占位符放开）；§3.1 拆出独立 [P1] KB；§10 末加 v0.0.62 落地确认 |
| `[P1]manifest_i18n.md` | 新增 | manifest 占位符协议（`__MSG_<key>__` 语法 + 适用范围 incl. EP description + resolveI18nField helper 契约）；拆独立 KB 防 [P0] 超 300 行硬限 |
| `log.md` | 修改 | 追加 v0.0.62 条目（thin 架构 + 实现层落地核实：9 ns bundle leaf 计数 + helper 落点 + role/memberState 决策 + BUG-001/002 修复） |

## 2. 核心技术决策（v0.0.62 全部沿用 v0.0.59，不变机制）

| # | 决策 | 一句话 |
|---|---|---|
| 1 | 复用 v0.0.59 KKV 协议 | 占位符四规则 + 兜底链 + 缺 key 报错全不改（task.json `invariants.arch_unchanged`） |
| 2 | bundle 物理结构不改 | 10 ns × 2 lng 文件路径不变，本版本只**填实** 9 ns（chat/studio/providers/plugin-config/app-dev-config/skill/connector/framework/common） |
| 3 | type code 走映射、自由文本走直展 | §7 范式不变；本版本扩展到 9 类 type code family（见 `i18n/index.md §⑥`） |
| 4 | displayReason 零 API breakage | §8 范式不变 |
| 5 | **manifest 占位符协议（新协议，落 [P1]）** | builtin plugin manifest 字段 + 内置 EP description 字段：字面文案 → `__MSG_<key>__` 占位符；后端 inventory 透传 string 不变；前端 `resolveI18nField(value, t)` helper 翻译 |
| 6 | **§3 line 51 修订（精化非推翻）** | 「后端永远不返回 key」改为两类区分：❌ 运行时动态数据不当 key（保留禁令本意）/ ✅ 产品代码声明占位符允许（manifest 等静态字段可用 `__MSG_`） |

## 3. 范式抽象：type code 通用 helper（v0.0.62 落地）

`app/web/src/i18n/code-key.ts` 抽出 `camelCaseCode(snake/kebab)` + `localizedCode(code, t, keyPrefix)` 通用范式，重构 5 处历史重复实现（`stop-reason.ts` / `llm-error-category.ts` / `board-view.tsx` / `auto-work-history.tsx`）。覆盖 9 类 type code family（snake_case + kebab-case 混用兼容）。

```typescript
// 通用范式（v0.0.62 抽象）
camelCaseCode('no_tool_call')    // → 'noToolCall'（snake_case）
camelCaseCode('file-changed')    // → 'fileChanged'（kebab-case）
localizedCode('no_tool_call', t, 'run.stopReason')   // → t('run.stopReason.noToolCall') → '已完成'
```

详见 `specs/tech/i18n/[P0]i18n_overview.md §6` + `index.md §⑥` 累积表。

## 4. 范式抽象：manifest 占位符协议（v0.0.62 落地）

`app/web/src/i18n/resolve-i18n-field.ts` 实现 `[P1]manifest_i18n.md §4` 契约。6 个组件接入：plugin-item / ext-impl-{radio,checkbox,ordered} / schema-config-modal / **section-ext-point-area**（最后一个是 BUG-002 修复时补的——EP description 也走占位符协议）。

```typescript
// resolveI18nField 顺序判定（[P1] §4.2）：
//   1. value 匹配 ^__MSG_(.+)__$ → 提取 capturedKey，返回 t(capturedKey)
//      （t() 内部走 [P0] §3 兜底链 + missing key 报错不 fallback 原文）
//   2. 否则 → 直展 value（兼容第三方/老 plugin 字面原文）
resolveI18nField('__MSG_plugin.builtin.rocky_context.label__', t)  // → 'Rocky Context'
resolveI18nField('第三方 plugin 字面描述', t)                          // → '第三方 plugin 字面描述'
```

落地范围（实测）：3 builtin plugin.json × 67 占位符（label/description/extImpls[].description）+ 12 EP description（extension-point.ts）+ ~14 schemaConfig description；plugin-config.json 106 leaf 覆盖全部。

## 5. 代码-spec 一致性核实（doc-modifier 阶段5 强制项，原则 12/13）

| # | 检查项 | 代码现状 | spec 状态 | 处理 |
|---|---|---|---|---|
| 1 | resolveI18nField helper 契约（[P1] §4） | `app/web/src/i18n/resolve-i18n-field.ts:41-53` 实现 §4.1 签名 + §4.2 顺序判定 + §4.3 missing key 不 fallback（t() 内部 parseMissingKeyHandler） | [P1] §4 契约已对齐 | ✅ 一致 |
| 2 | 占位符协议适用范围（[P1] §3.2） | 3 builtin plugin + 12 内置 EP + 6 组件接入（含 section-ext-point-area） | [P1] §3.2 已扩到 EP description | ✅ 一致（doc-modifier 补 [P1] §3.2 + §3.4 + §6 文件清单） |
| 3 | type code 累积映射表（index §⑥） | code-key.ts 通用 helper + 9 类 type code family（含 taskStatus/reqStatus/autoWork*） | index §⑥ 已扩到 9 行（doc-modifier 补 4 行） | ✅ 一致 |
| 4 | POST /session body.title → titled=true（BUG-001） | `session.ts:144-148` 走 updateSession CAS gate 翻 true | auto_naming/index §② + [P0] §6 + api/04 §2.1 + log 全部已补 | ✅ 一致 |
| 5 | manifest 字段类型 string 不变 | manifest.ts L29/L48/L64 + extension-point.ts L37 类型不变 | plugin_system/[P0]ext_impl §3.8 + extension_point §3.9 + i18n/[P1] §3.4 已补两形态规则 | ✅ 一致 |
| 6 | role/memberState 保留字面英文（领域术语） | 代码查表但 T3 reviewer 决定组件仍直展 code 字面 | log.md v0.0.62 + index §⑥ 对应行已标「保留字面英文」 | ✅ 一致（决策记录） |
| 7 | HTTP 错误体不本地化（归硬边界） | 全 handler 错误响应仍 `{error: msg}` 字面（不动） | 02-llm-chat.md v0.0.62 段 §4 已明文 + [P0] §2.2 硬边界 | ✅ 一致（PRD M4 premise 错已修正） |

**结论**：代码与 spec 全面对齐，无静默偏离。本版本期间所有发现（BUG-001/002 + HTTP 错误体漂移 + stopReason 7 值 + ConnectorConnection 4 值 + taskStatus/reqStatus/autoWork* 漏盘点）已同步落到 spec + log。

## 6. 跨 KB 协同

- `specs/api/overall/02-llm-chat.md` §1 `[v0.0.62 modified]`：SSE 域 type code 全量前端本地化（端点形状不变）+ HTTP 错误体硬边界确认
- `specs/api/overall/03-config-center.md` §3.1 `[v0.0.62 i18n modified]`：三级 description + schemaConfig description 现透传 `__MSG_` 占位符非字面中文
- `specs/api/overall/04-agent-session.md` §2.1 `[v0.0.62 i18n BUG-001]`：POST body.title 副作用补 titled=true（对齐 PUT）；§1 Session.title 注释已含 v0.0.62 i18n 渲染责任
- `specs/tech/agent/auto_naming/{index,[P0]auto_naming_service,log}.md` v0.0.62 段：POST 路径补 titled=true 协作
- `specs/tech/plugin_system/[P0]ext_impl_and_manifest_interface.md §3.8` + `[P0]extension_point_interface.md §3.9`：description 值两形态规则（字面 / `__MSG_` 占位符）
- `specs/prd/overall/04-config-center-ui.md` v0.0.62 段（已存在，含 9 ns 迁移条目）

## 7. 不在本版本（后续扩展点）

- **后端产生本地化文案**：HTTP 错误体 i18n（需新引入 `code` 字段扩硬边界）+ 未来其他产品代码静态字段（如 schema_defs 静态字段）走 `__MSG_` 占位符
- **role/memberState 走查表**：当前决策保留字面英文（领域术语）；未来若产品需求要求中文标签，bundle leaf 已备好（直接接 t()）
- **sessionState 走查表**：当前无 consumer（session state 由 status icon 表达）；common.sessionState.* leaf 已备好
- **fallbackNS 跨 ns 自动兜底**：当前显式 ns 取值（`t(key, {ns:'common'})` 或 `t('common:key')`）；如发现重复样板代码，再考虑 init 加 `fallbackNS: 'common'`
