---
type: change_log
title: v0.0.318 — 配置同步（模型 + 工具配置导入导出）
version: v0.0.318
date: 2026-08-10
related_prd: specs/prd/v0.0.318-config-sync.md
related_change_plan: specs/tech/version_logs/v0.0.318/change_plan.md
grounded: PRD §2/§3/§5 + change_plan D1–D6 + leader 裁决（md5→SHA-256 偏离）
---

# v0.0.318 — 配置同步（模型 + 工具配置导入导出）

> 一句话：**应用设置新增「配置同步」tab（memory 下方）**，模型 provider + 工具（web_search/web_fetch/see_image/bash）配置树形勾选导入导出，AES-256-CBC 加密 JSON 文件跨机器迁移。

## 1. 变更总览

**纯前端改动，后端零改动**（复用 `GET/POST /provider`、`POST /provider/:id/model`、`GET/PUT /config/app`，均已有）。

| 模块 | 文件 | 说明 |
|------|------|------|
| tab 注册 | `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | `TabId` 加 `'config_sync'`；`APP_SETTINGS_TABS` memory 后插入；`TAB_KV_GROUPS.config_sync = []`（自渲染不进 KV dirty） |
| 路由 | `app/web/src/components/app-dev-config-page/section-tab-panel.tsx` | switch 加 `case 'config_sync'` → `<SectionConfigSync />`（不走 SaveBar / page-tab dirty） |
| 加解密 | `app/web/src/lib/config-crypto.ts`（新建） | AES-256-CBC encrypt/decrypt + `{v, payload}` 壳封装；类型 `ConfigExportData`/`ProviderExportItem`/`ConfigExportFile` |
| 导出采集 | `app/web/src/lib/config-sync-export.ts`（新建） | `collectExportData` + `triggerDownload` + `TOOL_TAB_MAP` 工具映射常量 + `TOOL_TAB_IDS` |
| 导入执行 | `app/web/src/lib/config-sync-import.ts`（新建） | `parseImportFile` + `checkDuplicateLabels` + `executeImport` + `getLocalProviders` |
| 勾选树 | `app/web/src/components/app-dev-config-page/component-config-tree.tsx`（新建） | checkbox 三态树（folder 联动 + leaf 独立 + indeterminate 半选），export/import 双模式，重名标签 |
| 页面 | `app/web/src/components/app-dev-config-page/section-config-sync.tsx` + `section-config-sync-export.tsx` + `section-config-sync-import.tsx` + `section-config-sync-types.ts`（新建） | landing/export/import 三态；导出下载 / 导入确认 modal |
| i18n | `app/web/src/i18n/locales/{zh-CN,en}/app-dev-config.json` | `tab.config_sync.label` + `config_sync.*` 全部文案 |

## 2. 偏离项（coder 汇报 → leader 裁决 → 本文件记录）

| # | 偏离 | 类型 | 裁决 | 代码位置 |
|---|------|------|------|----------|
| 1 | **md5→SHA-256 密钥派生**：原方案「`rocky_agent_` + md5(固定盐) → SHA-256 → 32B AES key」（change_plan D2 / PRD §2.6），实现因 **crypto.subtle 不提供 MD5**，改用 `SHA-256(SALT)` 截 32 hex 替代 `md5(SALT)` | 实现偏离 | **接受**（功能等价：固定盐→固定串→固定 key；非安全场景，PRD §2.6 明确「防肉眼读取」级；同一版本产出的文件仍可跨机器互导） | `app/web/src/lib/config-crypto.ts` L48-58（`deriveAesKey`，注释已更新说明偏离） |

## 3. 其他实现要点（与 change_plan 对齐）

- **provider 选择 key = label（非 id）**：导出时 id 被剥离、导入时 id 未生成，D5 约束落地。
- **导入逐条 POST**：无批量端点，`executeImport` 逐条 `createProvider`（不传 id）+ 逐个 `createModel`；工具整 tab `putConfigGroup` 覆盖。
- **工具 group 映射**：web_search→`web_search/default` | web_fetch→`web`（仅 jina 三 key）| see_image→`see_image/default` | bash→`runtime/bash_seatbelt`。
- **重名提醒不阻止**：`checkDuplicateLabels` 按 label 精确匹配，树形页显示「存在重名」标签，checkbox 正常可选（老板拍板：不置灰、不拦勾选）。
- **文件结构**：`{ "v": 1, "payload": "<base64(IV+ciphertext)>" }`；文件名 `rocky_agent_config_YYYYMMDD_HHmmss.json`。
