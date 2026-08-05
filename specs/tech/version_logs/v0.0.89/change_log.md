---
version: v0.0.89
slug: ui_opt
title: 配置优化 — dev_config 废弃 + squad summaryModelDefault + session modelId 保留字 default + 模型选择器迁移
status: working
updated: 2026-07-08
---

# v0.0.89 跨版本发布说明（tech specs）

> 本文件是 tech specs 的**版本轴**发布说明（位置轴见各 KB 的 `log.md`）。
> 输入：PRD `specs/prd/version_logs/v0.0.89/` 5 工作块 + design-brief 8 决策。Method 级变更合同见 `change_plan.md`（214 行/75 变更/8 列）。

## 概要

| 类别 | 变更 |
|---|---|
| **后端 config 迁移** | dev_config entity + DevConfigService 整文件删；13 处消费方改读 AppConfigService；handlers 改名 dev-config-template → app-config-template；router `/config/dev` 删 + `/config/app/sub_agent_templates` 新增 |
| **model resolve 抽象** | 新建 `services/model-resolver.ts`（resolveModel + ModelNotConfiguredError，6 行 fallback 链）；保留字 `default`/`none`/`""`/`undefined` 统一走 fallback；6 处 handler 调用点切到 resolveModel（buildSessionConfigFromDeps 加 task 参数） |
| **squad schema** | Squad interface 加 `summaryModelDefault?: string`（与 modelDefault 正交独立，空=回退 modelDefault） |
| **session.modelId 保留字** | POST /session 缺省 → 落 `"default"`；PUT body.modelId 接受 `default`/`none`（规范化为 default）；resolveModel 视保留字为「继续 fallback」 |
| **配置页 tab 重构** | 左侧竖排导航树（通用/模型/工具/记忆 + 系统设置收起/可观测性/插件）+ page-tab 级 save-bar + default_models/请求设置 group + i18n appearance 合并 |
| **chat 模型选择器迁移** | topbar → input-bar（24×24 trigger + 三态 tooltip + 双场景菜单 + 双项语义 a(默认) vs 固定 a） |
| **migration script** | `scripts/migrate-dev-to-app.v0.0.89.sh`（dev→app 数据迁移，merge 后用户手动执行） |

## 各 KB 变更清单

### config/

- `[P0]app_config.md`：§3 group 集合大改 + 新增 §3.7 default_models + §3.8-§3.13 迁移自 dev_config + §3.1 appearance 合并 locale + §3.3 locale 标 deprecated。
- `[P0]dev_config.md`：标 DEPRECATED（status:deprecated）+ 顶部加 DEPRECATED 警示块 + 正文保留作历史参考。
- `index.md`：① 概念表更新（DevConfig 标 v0.0.89 deprecated）+ ③ 系统关系图（DevConfigService 标 DELETED）+ ④ 加原则 10「dev_config 废弃」+ ⑤ 导航更新。
- `log.md`：加 v0.0.89 条目（dev_config 废弃 + app_config 扩组 + default_models 新增 + appearance 合并 locale + 保留名偏离记录）。

### agent/providers_and_models/

- **新建 `[P0]model_resolve.md`**：model resolve 统一抽象（resolveModel + ModelNotConfiguredError + 6 行 fallback 链 + 保留字语义 + studio 不读 default_models 原则 + 错误体 schema）。
- `index.md`：① 概念表加 model resolve 行 + ⑤ 导航加 `[P0]model_resolve.md`（独立分类）。
- `log.md`：加 v0.0.89 条目（model resolve 抽象 + 6 行 fallback 链 + 保留字 helper 抽取 + session-provider-utils @internal）。

### agent/session/

- `[P0]session_store.md §2`：modelId 字段注释更新（保留字 `default`=未手动选/跟随默认；POST 默认 `"default"`；resolve 视为 undefined 继续走 fallback）+ providerId 字段降级注释（v0.0.9 历史持久化，resolver 不读）。
- `log.md`：加 v0.0.89 条目（session.modelId 保留字 + providerId 字段降级）。

### squad/

- `[P1]data_model.md §1.1`：Squad interface 加 `summaryModelDefault?: string` + 注释（与 modelDefault 正交独立，空=回退 modelDefault；POST/PATCH/SquadDetail 行为）。
- `log.md`：加 v0.0.89 条目（squad summaryModelDefault 字段新增 + CRUD 语义 + AT 覆盖）。

### multi_agent/

- `[P1]subagent_templates.md §3`：模板存储从 dev_config.sub_agent_templates 迁入 app_config.sub_agent_templates + §6 边界引用更新。
- `log.md`：加 v0.0.89 条目（sub_agent_templates 存储迁入 app_config + 路径迁移 + loadTemplateFromDevConfig 函数名保留）。

### i18n/

- `[P0]i18n_overview.md §5.2/§5.4/§6`：locale group 合并入 appearance（GET URL 改 group=appearance）+ changeLanguage 改 read-modify-write（含 theme+language 两 key）+ §6 链路总结改。
- `log.md`：加 v0.0.89 条目（locale group 合并入 appearance）。

### dev-logs/

- `[P0]overall.md §2.4`：LogWriter 构造形参 devConfig → appConfig；shouldWrite 读 appConfig.get('logs', ...)；§1/§2 注释段更新存储归属。
- `log.md`：加 v0.0.89 条目（logs group 迁入 app_config）。

## 核心设计原则（v0.0.89 落地）

1. **dev_config 废弃（一次性）**：所有 dev group 整批迁入 app_config，不可分批；失败回退 = 保留 dev_config 文件由用户验证后手删。
2. **保留字 `default`=继续 fallback**：session.modelId/squad.modelDefault/member.model 全部支持保留字 `default`/`none`/`""`/`undefined`，统一走 fallback；fallback 链跑空才抛 ModelNotConfigured。
3. **studio 不读 app_config.default_models**：playground 专属全局默认，混读会让 studio 默认值漂移到全局。
4. **ModelRef = 纯 modelId string**：不含 providerId 拼接；resolver 输出 `{providerId, modelId}` 两个字段（cross-provider 反查定位 providerId）。
5. **summary 链独立于 chat 链**：优先读 default_models.summary（playground）/ squad.summaryModelDefault（studio），不复用 chat 链次序。
6. **page-tab 级保存（非 per-group）**：当前 tab 内所有 KV group dirty 整体原子提交；provider 编辑器走独立 diff-save（不进 page-tab dirty）。
7. **appearance 合并 locale（read-modify-write）**：theme+language 同 group，PUT 整组避免覆盖；language 切即生效保持（不走 page-tab dirty）。

## 偏离与同步（保留名作过渡）

代码层保留名（已 verified reasonable，spec 同步实际）：

| 保留名 | 实际切到 | 理由 |
|---|---|---|
| `loadTemplateFromDevConfig` 函数名 | 实现已切 app_config（参数 devConfig→appConfig） | 避免下游 import 大规模改名 |
| `JinaDevConfig` 类型名 + `JinaContentFetcherCtor.devConfig` 字段名 | race-runner.ts:84 桥接 `devConfig: options.appConfig` | 避免 JinaContentFetcher 内部 API 连锁改名，仅注释级文档语义切换 |
| `ContextEngineOpts.devConfig` 字段名 | 改 `appConfig`（消费方读取入口切换，仅类型/字段名重命名） | 同源 service 单点注入 |

**SessionConfig.devConfig 字段删除**（合并入既有 appConfig 字段，比 change_plan 原计划「字段改名」更 DRY——同源 service 单点注入避免冗余；web_fetch 改读 ctx.config.appConfig 取 web group）。

## AT 覆盖（10 case）

| # | 模块 | case | 路径 |
|---|---|---|---|
| P1 | e2e/config | tab_switch_save_cancel | 切 tab dirty 弹确认 + page-tab 级保存 |
| P2 | e2e/config | provider_independent_save | provider 编辑器走独立 dirty 不进 page-tab |
| P3 | e2e/config | appearance_merged | appearance group 含 theme+language；切 language 切即生效 |
| P4 | api/config | default_models_crud | GET/PUT default_models group；x 清除写 undefined |
| P5 | e2e/config | request_settings | 请求设置 group 暴露 stall_tool_s + max_attempts |
| P6 | e2e/chat | model_picker_input_bar | input-bar 内 InputModelPicker trigger 三态 + 菜单双场景 |
| P7 | api/session | model_default_resolve | resolveModel fallback 链 + MODEL_NOT_CONFIGURED 错误体 |
| P8 | api/compact | summary_model_fallback | compact 走 summary 链 + default_models.summary 优先 |
| P9 | api/multi_agent | squad_summary_model | POST/PATCH/GET squad summaryModelDefault 三态 |
| P10 | api/config | dev_to_app_migration | GET /config/app?group=<原 dev group> 迁后落点 + /config/dev 返 404 |

## merge 后用户操作

1. **跑数据迁移脚本**：`bash scripts/migrate-dev-to-app.v0.0.89.sh`（默认删 dev_config；`--keep-dev-config` 反向开关保留作验证）。
2. **验证迁移结果**：脚本输出 `migrated: N, skipped: 2 (dead), failed: 0`；backup 在 `dev_config.backup-<ts>/`。
3. **回滚**（如失败）：脚本自动 rollback 已迁文件 + 保留 backup；用户手删 app_config 迁来的 group 后再重跑。
