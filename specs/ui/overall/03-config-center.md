# Config Center UI（配置中心）

> 管什么：配置中心渲染层 UI 契约—— app config 三栏 + dev config 三栏 + plugin config 两 tab（插件 / 扩展点）+ ext impl type 分化渲染（exclusive=radio / list=checkbox / ordered=拖拽+开关）+ impl schema config 弹层。
> 不管什么：HTTP 端点（→ `specs/api/overall/03-config-center.md`）；chat 主界面（→ `02-llm-chat.md`）；设计 token 原值（→ `specs/ui/regulation/01-tokens.md`）；具体组件契约（→ `specs/ui/components/{framework,common,app-dev-config-page,plugin-config-page}/`）。

## 1. 概述

配置中心 = **三栏 app/dev config 页（共享 `section-config-layout`）+ plugin config 两 tab 页（插件 + 扩展点）**。所有页面共用 framework + common 组件，5 层组件式架构（primitive → component → section → page → framework）。

一句话：**nav-rail（左 56px 功能导航）+ 各页主区（三栏 KV / 两 tab 插件管理）；每 key 卡片 + 每 group 独立保存；ext impl 按 type（exclusive/list/ordered）分化控件；schema config 弹层**。

### 1.1 路由（`currentView` 切主区）

| `currentView` | 主区渲染 | 入口 |
|---|---|---|
| `"settings-app"` | `page-app-settings` 合并页（三栏，内含 app / dev / plugin 三块配置 tab） | nav-rail「应用设置」图标 |

> plugin / dev 配置已合并入 settings-app 页内 tab（三合一）。nav-rail 契约见 `specs/ui/components/framework/nav-rail.md`。

## 2. app / dev config 页（三栏 + group 独立保存）

两页结构一致（`section-config-layout` + `common/section-group-list` + `component-key-card` 共用），差异仅 group 集合（app: appearance / providers / locale / tools 等；dev: `llm_request` + `observability` + `logs`）。**两页数据均归 `app_config` entity**（端点走 `/config/app`；group schema 见 `specs/tech/config/[P0]app_config.md §3`）。

### 2.1 三栏结构

```
┌────────┬──────────────┬────────────────────────────────────┐
│ 56px   │ group 列表   │ 配置区域                           │
│ nav-   │ section-     │ section-config-layout              │
│ rail   │ group-list   │  ├─ component-key-card（每 key）   │
│ 图标栏  │ appearance   │  ├─ component-key-card             │
│        │ providers    │  └─ ...                            │
└────────┴──────────────┴────────────────────────────────────┘
```

- **中栏 group 列表**：列出所有 group，点击切换右栏配置区域；选中项左竖条 + 浅底。
- **右栏配置区域**：选中 group 下所有 key，每 key 一张 `component-key-card`（key 名 + 说明 + 控件：primitive-key-input / -choice-cards / -boolean）。
- **tab 级统一保存（v0.0.317）**：group 底部独立保存条已废弃，统一走 tab 级 SaveBar（`common/component-save-bar`）——当前 tab 内任一改动 → dirty 高亮 + 显示取消；保存 = 当前 tab 全部 dirty 整体提交；取消 = 重置 draft。

### 2.2 app config 特有 group

- **`appearance` group**：theme 选项（dark/light 选项卡），切立即生效（CSS 变量切换 + PUT 持久化）。沿用 theme-init 首屏机制（见 `02-llm-chat.md §5`）。
- **`providers` group**：provider/model 实例 CRUD 入口（端点 `/provider` + `/provider/:id/model`）。由 `SectionProviders`（`app/web/src/components/providers/section-providers.tsx`）自管理三级流（list → detail → model 弹层）+ 统一 diff-save。二级页含 protocol 单选（复用 `primitive-key-choice-cards`，禁原生 `<select>`）+ 拼接地址 mono 只读展示。交互要点：「确定 ≠ 保存」（model 弹层确定只回写 draft，provider-save 才触后端）；dirty 指示（改前 ● / 保存后 ✓）。详见 `specs/ui/components/providers/_overview.md`。
- **`locale` group**：语言选择器卡片（key=`language`），控件 = `primitive-key-choice-cards`（两选项卡 `zh-CN` / `en`）。**选项 label 语言自指**：「中文」始终显示「中文」、「English」始终显示「English」（不随当前 locale 变）。**v0.0.317（D8）改为受控**：选语言只进 draft（UI 不切），走 tab 级 SaveBar 统一保存；点保存才调 `i18n.changeLanguage(lng)`（切 UI + PUT 持久化一起做），与配置面板其他控件统一。启动期 `initI18nFromConfig()` 在 React 渲染前 await（对齐 theme-init 范式）。i18n 范式见 `_conventions.md §8a`。
- **工具 tab**（tabId=`tools`）：三个自渲染 section——
  - **web_search（网络搜索）**：描述 + type 下拉选择框（2 option：`zhipu_coding_plan` / `zhipu_api`，选中项 `aria-selected='true'`）+ 选中 impl 的 apiKey SecretInput + 保存/重置按钮；无候选 impl 时显空态提示。数据 = `app_config.web_search.default`（GET/PUT `/config/app?group=web_search`）。
  - **web_fetch（网络抓取）**：描述 + jinaApiKey SecretInput（展示态/编辑态/✓ 提交按钮）+ 保存/重置。数据 = `app_config.web.jinaApiKey`（GET `/config/app?group=web`，单 key PUT）。
  - **see_image（看图理解，紧邻 web_fetch 下方）**：描述 + type 下拉选择框（implId-agnostic，2 option：`minimax_m3` / `zhipu_image`）+ 选中 impl 的 apiKey SecretInput + 保存/重置 + 空态。数据 = `app_config.see_image.default`。
  - 组件 spec 见 `specs/ui/components/app-dev-config-page/section-{web-search,web-fetch,see-image}-config/`。
- **整理 tab**（tabId=`consolidation`，系统设置收起区，与 observability/plugin 同级）：自渲染 `section-consolidation-config`（组件 spec `specs/ui/components/app-dev-config-page/section-consolidation-config.md`）——`enabled`（天级二级整理开关）+ `dailyTime`（每天触发时刻）+ `modelId`（模型选择）三字段走 `useAppSettingsConfig` dirty 跟踪与整组保存（PUT `/config/app?group=consolidation`）；下方**任务面板**：「立即整理」按钮（POST `/consolidation/run`，202 触发 / 409 已在跑）+ 上次整理时间/一句话摘要只读区（`GET /consolidation/status`）。
  - **running 状态正确反映** [v0.0.205.t2_cons]：`GET /consolidation/status` 响应含 `status: 'running'|'idle'|'failed'` + `startedAt`；面板 onInit 据此初始化 `isRunning`（不再写死 false）——整理进行中切走 tab 再切回，按钮仍禁用显「整理中...」（修切走切回按钮可点 UX bug）；running→done/failed 迁移由 SSE `consolidation_task_update`（topic `app_task`/`_all`）驱动（配置中心唯一有 SSE 的 group）。
  - **超时自愈 UX 语义**：任务 hang 超 1h 后，下次触发（cron 到点或手动点击）服务端自动接管旧锁正常开跑，按钮随 SSE 事件恢复可点——用户无需干预（实现细节归 `specs/tech/agent/session/[P0]app_task_lock.md §3.1`，本页只呈现结果）。
- **配置同步 tab**（tabId=`config_sync`，[v0.0.318] 用户设置区 memory 紧邻下方）：自渲染 `section-config-sync`（组件 spec `specs/ui/components/app-dev-config-page/section-config-sync.md`）——**独立操作页**（即时操作，不走 SaveBar / page-tab dirty，`TAB_KV_GROUPS.config_sync=[]`）。landing 两入口（导出配置 / 导入配置）→ export（ConfigTree 默认全选 + 导出下载 `rocky_agent_config_YYYYMMDD_HHmmss.json`）/ import（文件选择 → 解密解析 → ConfigTree 默认全选 + 重名标签「存在重名」+ ConfirmModal → 执行导入）。模型 provider 注入（POST 生成新 id）+ 工具整 tab 覆盖（web_search/web_fetch/see_image/bash）。详见 `specs/ui/version_logs/v0.0.318-config-sync/change_log.md`。
- **团队同步 tab**（tabId=`team_sync`，[v0.0.319] 用户设置区 config_sync 之后）：自渲染 `section-team-sync`（组件 spec `specs/ui/components/app-dev-config-page/section-team-sync.md`）——**独立操作页**（即时操作，不走 SaveBar / page-tab dirty，`TAB_KV_GROUPS.team_sync=[]`）。landing 两入口（导出团队 / 导入团队）→ **[v0.0.321] 导出 = 弹选择器**（`component-export-team-picker-modal`：`listSquads()` 全量列表 → 默认选中当前 `squadId` ?? 第一项 → 确定 `exportSquad(selectedId)` 下载 zip；4 态 loading/error+重试/empty/列表；`exportGenRef` 竞态守卫）→ 不再直下当前团队、无 studio 会话也不再禁用（可弹层选其他团队）/ 导入两阶段（文件选择 → preview 信息卡 + 新团队名 + 重名提醒不阻止 → ConfirmModal → execute）。**squadId 来源（v0.0.319 ET 修复后）**：`listStudioSessions()`（GET /session?biz=studio 按 updatedAt desc）取最近活跃带 squadId 的 studio 会话，**不用 useChatStore**（playground 专属 store 拒纳 biz=studio）。详见 `specs/ui/version_logs/v0.0.319-team-sync/change_log.md` + `specs/ui/version_logs/v0.0.321-team-export-picker/change_log.md`。

### 2.3 dev config 特有 group

- **`llm_request` group**：`stall_timeout_s`（数字）+ `max_retry_times`（数字），普通 key-card 路径。
- **`observability` group**：list-of-objects（多 backend 实例列表），**不走**普通 key-card 路径，右侧渲染 `section-observability-list`（见 §6）。
- **`logs` group**：普通 KV group，4 个 boolean key（`enableLlmRequestLog`/`enableToolResultLog`/`enableAppApiLog`/`enableEventLog`，默认 false），走 key-card boolean toggle 路径。开关 schema 见 `specs/tech/config/[P0]app_config.md §3.8`，hook 契约见 `specs/tech/dev-logs/[P0]overall.md`。

## 3. plugin config 页 · 插件 tab

顶部两 tab（「插件」/「扩展点」），默认插件 tab。插件 tab 主区 = `section-plugin-list`（每行 `component-plugin-item`：名称 + 描述 + enabled 开关）。

**核心约束**：每个 plugin 的 enabled 开关**独立 state slice**——切 plugin A 开关**绝不**影响 plugin B。

**整页只读**：所有 plugin / ext impl 配置 + scope 列表均代码声明（`app/plugins/scopes/*.yaml`），界面只读。顶部只读 banner（i18n `plugin-config:page.readonlyBanner`）提示配置已代码化；plugin toggle 全 disabled。

## 4. plugin config 页 · 扩展点 tab（ext type 分化）

### 4.1 结构

扩展点 tab 主区**两栏**：左 `common/section-group-list`（按 group 聚类，group 拆分数据驱动——来源 `app/plugins/groups.json` 唯一源）；右 `section-ext-point-area`（选中 group 下所有扩展点 + impl，按扩展点 type 分化渲染）。inventory 数据流为嵌套 `groups[].points[].impls[]`（UI 嵌套迭代外层 group → point → impl）。

**顶部 scope 切换器**（`component-scope-switcher`）：扩展点 tab 顶层，scope = ext-impl 配置层正交维度（agent loop 风格，与 group 功能分区正交），每个 scope 独立持有 enabled/order/configValues 一份。只读化后**仅切换查看**（无创建/删除入口）。default 始终首位 + 「基线」badge。切换 scope → 父级 `GET /config/plugin?scopeId=<id>` 刷新整个 inventory。

**per-EP 激活/灰显态**：
- **default scope**：全 EP 永远激活基线，impl 全亮。
- **非 default scope + EP 未激活**：EP header 显「继承 default」提示（`ext-point-{pointId}-inactive-hint`，i18n `plugin-config:page.epInactiveHint`）；该 EP 下 impl 强制 `disabled` 灰显（enabled/order/configValues 回退取 default 视图）。
- **非 default scope + EP 已激活**：impl 正常显示该 scope 独立配置。

**布局稳定性（MANDATORY）**：scope dropdown 用 `absolute` 脱离常规流；切 scope 时切换器自身位置固定（不重排）。

### 4.2 ext impl type → 控件映射

| type | UI 控件 | 选中语义 |
|---|---|---|
| **exclusive** | `component-ext-impl-radio`（radio） | 选其一 → 同扩展点其余 impl enabled=false（变灰） |
| **list** | `component-ext-impl-checkbox`（checkbox） | 各自独立勾选/取消，可多选 |
| **ordered** | `component-ext-impl-ordered`（拖拽手柄 + 开关） | 拖动改 order；开关切 enabled；**两者互不干扰**（order 与 enabled 正交）。拖拽用 transform / 预留高度，禁跨行位移 |

每 impl 行展示：implId + pluginId（副，灰）+ pointId 标签 + 「配置」齿轮按钮（仅 configSchema 存在时显示；只读化后仍渲染，弹层为 readOnly）。

## 5. impl schema config 弹层（`component-schema-config-modal`）

impl 行末尾「配置」齿轮 → 点击弹层。弹层标题 = implId + pointId；按 configSchema 顺序渲染每 key 一行（label + 控件，控件由 schema.type 路由）。弹层内独立保存/取消，不影响外层 impl 的 enabled/order。**整页只读化后弹层为 readOnly**。

### 5.1 schema.type → 控件映射

| schema.type | 控件（primitive） | 说明 |
|---|---|---|
| `string` | `primitive-key-input`（text） | 文本输入 |
| `number` | `primitive-key-input`（number） | 数字输入 |
| `boolean` | `primitive-key-boolean`（switch） | 开关 |
| `enum` | choice-cards（禁原生 `<select>`，见 `_conventions.md §10`） | options 来自 schema.options |
| `object` | 分组容器，内嵌上述控件 | 多 key 嵌套 |

> schema 源统一 `ExtImpl.configSchema`；`config` 始终 = manifest default ⊕ scope configValues 合并。保存时前端发**稀疏 delta**（只含用户改过的 key），详见 `specs/api/overall/03-config-center.md §3.2`。

## 6. observability group（list-of-objects，list/detail 两视图）

dev config 页 `observability` group，结构异于普通 key-value group（**多 backend 实例列表**，每项独立 id/启停/删除）。权威组件 spec：`specs/ui/components/app-dev-config-page/observability-config/`。

**两视图分支**：
- **list 视图**：标题「可观测性配置」+ desc + provider-card 列表（logo + 状态点 + name + 启用/禁用 badge + desc 行 `{type} · {baseUrl} · {desc}` + toggle + 删除）+ 添加卡。
- **detail 视图**：breadcrumb「可观测性 / {name}」+ 头部（logo+name+type+toggle）+ 基础信息 section（name + type 竖排各占一行，type 只读 `langfuse`）+ 认证密钥 section（publicKey 明文、secretKey password 脱敏）+ 物理层记录 section（logPhysical 开关，label「双重记录」+ hover tooltip）+ save-bar（dirty 指示 + 重置 + 保存）。

**交互**：enabled toggle 即时生效（不进详情、不计 dirty）；改字段（含 logPhysical 开关，**计 dirty** 需保存）→ dirty → 保存/重置；删除走 modal 二次确认。配置不热更新（改后提示重启生效）。secretKey 处理：GET 返回明文，mask 收敛前端 `SecretInput` 展示层；PUT `"***"` 占位 merge 保留原值（见 `specs/api/overall/03-config-center.md §3.5`）。

> **概念边界**：UI 只管 CRUD + 启停；observability manager（fan-out/容错/多实例）= tech 范畴。

## 7. 边界

| 零件 | 归属 |
|---|---|
| 配置中心页面级契约（三栏 / 两 tab / type 分化 / scope / 弹层） | 本文 ✅ |
| 组件契约（22+ 组件） | `specs/ui/components/{framework,common,app-dev-config-page,plugin-config-page,providers}/` |
| HTTP 端点 | `specs/api/overall/03-config-center.md` |
| group schema / app_config entity | `specs/tech/config/[P0]app_config.md` |
| ext impl scope 技术权威 | `specs/tech/config/[P0]ext_impl_scope.md` |
| i18n 基础设施 | `specs/tech/i18n/` |
