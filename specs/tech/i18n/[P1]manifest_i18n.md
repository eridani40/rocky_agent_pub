---
type: spec
title: manifest i18n 占位符协议（P1）
priority: P1
status: active
updated: 2026-07-04
since: v0.0.62
relates-to: "[[P0]i18n_overview.md]"
---

# manifest i18n 占位符协议（P1）

## 1. 概述

**本 KB 是 `[P0]i18n_overview.md §3` KKV 占位符协议在 manifest 场景的扩展协议**。`[P0] §3` 的四规则（字面直展 / 占位符查 KKV / 兜底链 / 缺 key 报错）不变；本 KB 只补充「manifest 等产品代码静态字段如何用 `__MSG_<key>__` 占位符声明 i18n key」的载体协议 + 配套 `resolveI18nField` helper 契约。

**动机**：builtin plugin 的 manifest 字段（`label` / `description` / `extImpls[].description` / `schemaConfig.<key>.description`）是产品代码静态声明，与前端组件里写 `t('chat.sendButton')` 同质——都是「产品代码声明 i18n key」，仅载体不同（JSON vs TSX）。原 `[P0] §3 line 51`「后端永远不直接返回 i18n key」对动态数据是必要的（防 raw key 漏迁移事故），但对产品代码声明过于严格。本 KB 放开后者并定协议。

**配套的 [P0] §3 line 51 修订**（v0.0.62，详见 `[P0]i18n_overview.md`）：
- ❌ 运行时动态数据不当 key（保留禁令本意）：用户数据 / LLM 输出 / squad.name / 动态自由文本 —— 原样直展不当 key。
- ✅ 产品代码声明占位符 key 允许（放开）：manifest 等产品代码静态字段可用 `__MSG_<key>__` 占位符声明 i18n —— 详见本 KB §3。

## 2. 业界标准对齐

- **WebExtension `__MSG_`**（MDN/W3C，Chrome/Firefox/Edge 通用）：`manifest.json` 写 `"name": "__MSG_extName__"` + `_locales/<lng>/messages.json` 存翻译。
- **react-i18next「backend returns keys」**（官方推荐）：后端返回 key 字符串而非本地化文案，前端按 locale 查表。

本协议 `__MSG_<dotted.key>__` = 融合 WebExtension `__MSG_` 业界标准 + v0.0.59 点路径 key 命名（`<ns>.<scope>.<leaf>`）。

## 3. 语法与适用范围

### 3.1 语法

`__MSG_<dotted.key>__`

- 示例：`"description": "__MSG_plugin.builtin.rocky_context.impl.ingestTruncate.description__"`
- **正则识别**：`^__MSG_(.+)__$`（capture group = 完整 dotted key）

### 3.2 适用范围

manifest 等产品代码静态字段（builtin plugin 文案：`label` / `description` / `extImpls[].description` / `schemaConfig.<key>.description`）+ **内置 ExtensionPoint 的 `description` 字段**（v0.0.62 BUG-002 修复时补：`app/server/src/plugin/extension-point.ts` 内 12 内置 EP description 全部 `__MSG_extpoint.<id>.description__` 占位符化，前端 `section-ext-point-area.tsx` 经 resolveI18nField 翻译 `pointDescription` 字段）。

### 3.3 不适用

运行时动态数据（用户数据 / LLM 输出 / 动态自由文本）—— 走 `[P0] §3` 规则 (1) 字面直展规则。

### 3.4 字段格式不变

`description` 仍是 `string` 类型（`app/server/src/plugin/manifest.ts` L29/L48/L64 + `app/server/src/plugin/extension-point.ts` L37 ExtensionPoint.description），只是值从字面文案变成占位符 —— 向后兼容老 plugin / 第三方 plugin 的字面值（helper 直展 fallback，见 §4）。

### 3.5 后端零改

`inventory-builder.ts::buildExtImplNode` 透传 string 不变（L224 `description: entry.manifest.description ?? ''`），符合 `[P0] §6` 后端不 locale 决策。

### 3.6 单一数据源

占位符 key 在 manifest 声明，文案在 locale bundle —— 不再需要前端按 plugin id 凭空映射（解决「前端凭空生成 plugin 语义文案」问题）。

### 3.7 新增 ext impl 强制同步

builtin plugin 新加 ext impl 时，manifest 写 `__MSG_<key>__`、locale bundle 必须有对应 key —— 否则 helper 走 `[P0] §3` 规则 (4) 缺 key 报错（不静默 fallback 原文），漏翻译立即暴露（解决「新增 ext impl 不同步」问题）。

## 4. resolveI18nField helper 契约

### 4.1 签名

`resolveI18nField(value: string, t: TFunction): string`（`TFunction` 来自 `react-i18next`）

### 4.2 逻辑（顺序判定）

1. value 匹配正则 `^__MSG_(.+)__$` → 提取 capturedKey，返回 `t(capturedKey)`
   - `t()` 内部走 `[P0] §3` 规则 (2)→(3)→(4)：查到 → 返回 locale 文案；当前 lng 缺 → 兜底链（当前→en→zh-CN）；三级全缺 → 规则 (4) 报错「【资源 <key> 不存在】」。
2. 否则 → 直展 value（兼容第三方 plugin 字面原文 / 未改造字段 / 老 plugin）

### 4.3 missing key 不 fallback 原文

占位符声明了 i18n，缺翻译是 bug，必须暴露（**不 fallback 到 raw `__MSG_...__` 字面、也不 fallback 到任何「兜底文案」**）—— 这是 §3.7「新增 ext impl 强制同步」的机制保障。

### 4.4 通用性

不只 plugin 用，任何后端返回的 i18n 候选字段都能复用（如未来 schema_defs 静态字段、其他产品代码声明字段）。

### 4.5 落点

`app/web/src/i18n/resolve-i18n-field.ts`（与 `llm-error-category.ts` 同目录，独立工具函数）。

### 4.6 UT 覆盖三类 case

- 占位符识别 + 查到 → 返回 locale 文案
- 占位符识别 + missing key → 走规则 (4) 报错（不 fallback 原文）
- 非占位符（字面文案）→ 直展 value

## 5. 示例（rocky_context manifest 改造前后对比）

**改造前**（v0.0.59，字面中文硬编码）：
```json
{
  "label": "Rocky Context",
  "description": "上下文管理",
  "extImpls": [
    { "id": "ingestTruncate", "description": "压缩并截断上下文" }
  ]
}
```

**改造后**（v0.0.62+，`__MSG_` 占位符）：
```json
{
  "label": "__MSG_plugin.builtin.rocky_context.label__",
  "description": "__MSG_plugin.builtin.rocky_context.description__",
  "extImpls": [
    { "id": "ingestTruncate", "description": "__MSG_plugin.builtin.rocky_context.impl.ingestTruncate.description__" }
  ]
}
```

配套 locale bundle（`app/web/src/i18n/locales/zh-CN/plugin-config.json`）：
```json
{
  "plugin": {
    "builtin": {
      "rocky_context": {
        "label": "Rocky Context",
        "description": "上下文管理",
        "impl": {
          "ingestTruncate": { "description": "压缩并截断上下文" }
        }
      }
    }
  }
}
```

渲染链路：`inventory-builder` 透传 string → 前端 plugin 配置组件 `resolveI18nField(description, t)` → 匹配 `__MSG_` → `t()` 查 locale 表 → 显示「压缩并截断上下文」（zh-CN）/ "Truncate and compress context"（en）。

## 6. 文件变更清单（v0.0.62 架构层）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/web/src/i18n/resolve-i18n-field.ts` | 新增 | `resolveI18nField(value, t)` 通用 helper：`__MSG_` 匹配 → `t()`，否则直展；missing key 走 `[P0] §3` 规则 (4) 报错不 fallback 原文（§4 契约） |
| `app/server/src/plugin/manifest.ts` | 不改 | `description: string` 类型不变（§3.4），仅 builtin plugin 的 manifest JSON 值从字面文案改为 `__MSG_<key>__` 占位符 |
| `app/server/src/plugin/extension-point.ts` | 不改（类型） / 改（值） | `ExtensionPoint.description` 类型不变（§3.4）；12 内置 EP 常量的 description 值改为 `__MSG_extpoint.<id>.description__` 占位符（BUG-002 修复） |
| `app/server/src/plugin/inventory-builder.ts` | 不改 | 透传 string 不变（§3.5） |
| `app/web/src/i18n/locales/{zh-CN,en}/plugin-config.json` | 新增/扩展 | builtin plugin × ~64 文案 keys（label/description/extImpl description/schemaConfig description）+ 12 EP description × 2 语言 = 106 leaf |
| `app/web/src/components/plugin-config-page/*` | 修改 | 6 个渲染 manifest 字段的组件改用 `resolveI18nField` 替代字面直展：plugin-item（label/desc）/ ext-impl-{radio,checkbox,ordered}（impl desc）/ schema-config-modal（schemaConfig desc）/ **section-ext-point-area**（EP pointDescription，BUG-002 补） |

> 变更历史见 `log.md`；本协议扩展自 `[P0]i18n_overview.md §3`（KKV 基础协议），跨版本发布说明见 `specs/tech/version_logs/v0.0.62.i18n_migration/change_log.md`。
