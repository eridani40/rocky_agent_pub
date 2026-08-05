# 配置中心 UI — Config Center [v0.0.5]

> version: 1.6 · 引入版本 v0.0.5 · 最后更新：2026-07-15（**v0.0.149 modified**：应用设置新增「会话」tab（排 general 后第二）——集中管理 skill/memory 注入数量 + playground 默认模型 + LLM 请求参数；新 group `session`（key=default，data={maxSkillInject?, maxMemoryInject?}，缺失回退 50）；`default_models` + `llm_request` 两 group 从模型 tab 迁到会话 tab（纯 UI section 重组，group 名/契约/保存语义不变，后端不动）；模型 tab 仅剩 providers；详 `specs/prd/version_logs/v0.0.149.memory_opt/change_log.md` §4）；**v0.0.71 modified**：plugin ext 配置展示重构——inventory 数据流改嵌套 `groups[].points[].impls[]`（D3，UI 嵌套迭代外层 group → point → impl）；group 拆分数据驱动（D5 7 group，来源 `app/plugins/groups.json` 唯一源，删 `ExtensionPoint.group` 字段）；impl 配置入口恢复（齿轮按钮在 v0.0.67 整页只读下也渲染，删 `!disabled` 守卫，修 bug-B）+ schema config modal 改 readOnly（D4）；schema 源统一 `ExtImpl.configSchema`（D7 删 `schemaConfig`）+ `config` 始终 = manifest default ⊕ scope configValues 合并（bug-A 修复，`threshold_should_compact.compactRatio=0.6` 配置页可见）；**无用户可见行为变更**（运行时两级 enabled 门 / cardinality / scope 回退算法不变；管理页 v0.0.67 起只读化保留）。详 `specs/prd/version_logs/v0.0.71.md`）；v0.0.47 修订：设置入口三合一——§3.9.10 新增（app+dev+插件 合为「应用设置」单入口 + 「展开系统配置」分割线 + dev tabs + 插件 tab + SKILLS/连接器 移到 nav 底部独立入口 + 路由收敛）；v0.0.26：扩展点 tab 顶层加 scope 切换器 + per-EP 激活/灰显，详见 §3.9.9；v0.0.13 修订：扩展点 tab 新增 context group —— 数据层新增，UI 渲染规则不变，详见 §3.9.4 备注）
> 本文承载 v0.0.5 配置中心重构的全量产品需求，是 `03-llm-chat-features.md` §3.7（设置 UI，已被 v0.0.5 取代）+ §3.8（EP.group + inventory，v0.0.5 在此扩展为 ext type 分化渲染）的**权威继承者**。
> 增量记录见 `specs/prd/version_logs/v0.0.5/change_log.md`。
> 设计参考：`reqs/v0.0.5/design-prompt.md` + `easy-opc-config-center-v4.html`（外部工具产出的 html 原型）。
> 前端组件契约：`specs/ui/components/`（framework/common/app-dev-config-page/plugin-config-page 四目录，22 组件 md+tsx）+ `specs/tech/app/frontend/[P0]component_architecture.md`。

## 目录

| 章节 | 说明 |
|------|------|
| §3.9.1 设计原则 [v0.0.5] | 三栏 / 两 tab / ext type 分化 / schema 弹层 / plugin 开关独立 |
| §3.9.2 app/dev config 页（三栏 + group 独立保存） | 配置 KV 页统一三栏化 |
| §3.9.3 plugin config 页 · 插件 tab | plugin 开关独立（修复 v0.0.4 联动 bug） |
| §3.9.4 plugin config 页 · 扩展点 tab（ext type 分化） | exclusive=radio / list=checkbox / ordered=拖拽+开关 |
| §3.9.5 impl schema config 弹层 | 按 schema 渲染控件 |
| §3.9.6 关键用户路径（MANDATORY — 测试最低覆盖） | 6 条核心路径 + UC 表 |
| §3.9.7 providers group 三级流 + diff-save [v0.0.7] | providers group 重做：list → detail → model 弹层 + 唯一保存 + label/enabled |
| §3.9.9 扩展点 tab · scope 切换器 [v0.0.26] | ext-impl 配置层 scope 维度（agent loop 风格）+ per-EP 激活 + 灰显继承 default |
| §3.9.10 设置入口三合一 [v0.0.47] | app+dev+插件 合为「应用设置」单入口；SKILLS+连接器 移到 nav 底部独立入口 |

---

## 3.9.1 设计原则 [v0.0.5]

> 对齐 `states/v0.0.5/task.json` keyDecisions，不推翻。

1. **三栏 config（app/dev 共享）**：app config 页与 dev config 页结构一致——「功能导航（56px nav-rail）+ group 列表（一级选择）+ 配置区域（选中 group 内容）」。两页共用 `section-config-layout` + `section-group-list`（common）+ `component-key-card` + `component-group-save-bar`。见 `specs/ui/components/app-dev-config-page/` + `common/`。
2. **key 卡片化**：配置区域每个 key 一张独立卡片（key 名 + 说明 + 控件），控件类型由 key schema 决定（text/number/select/boolean → 对应 primitive-key-input/select/boolean）。
3. **group 独立保存**：每个 group 一个「保存」按钮（`component-group-save-bar`），提交该 group 全部 key。多 group 改动互不串扰，仅「保存」对应 group 才落盘。有未保存改动时按钮高亮 / 显「●」。
4. **plugin config 两 tab**：顶部 `插件` / `扩展点` 两 tab。插件 tab = 纯 plugin 列表（名称+描述+开关）；扩展点 tab = group 列表 + 扩展点/impl 管理。
5. **ext point 按 type 分化渲染**（v0.0.5 核心）：扩展点声明 `type: exclusive | list | ordered`，UI 按 type 渲染不同选择控件：
   - **exclusive（互斥）**：radio 单选，选其一自动 disable 其余。
   - **list（列表）**：checkbox 独立勾选。
   - **ordered（有序）**：拖拽手柄排序（`primitive-drag-handle`）+ 独立 enabled 开关，两者互不干扰。
6. **impl schema config 弹层**：impl 若声明 `schemaConfig`，末尾「配置」入口（齿轮）→ 弹层（`component-schema-config-modal`），控件由 schema.type 驱动（string/number/boolean/enum/object），弹层内独立保存/取消。
7. **plugin 开关独立（修复 v0.0.4 bug）**：每个 plugin 的 enabled 开关拥有**独立 state**，严禁共享（v0.0.4 现象：开 A 关 B 联动，不合理）。开关 = `primitive-toggle-switch`，每个 plugin 一份。
8. **布局稳定性（沿用 §2.3 MANDATORY）**：按钮只允许「始终可见」或「hover 出现」，出现/消失绝不导致相邻元素位移。脏状态提示「●」用预留空间 / 绝对定位，禁 `display:none` 入常规流。
9. **EP.group + inventory group-centric（沿用 v0.0.4 §3.8）**：扩展点 tab 的 group 列表来自 `PluginConfigService.inventory()`（按 EP.group 聚合）。group=展示分区，enabled=行为门，正交。

---

## 3.9.2 app / dev config 页（三栏 + group 独立保存） [v0.0.5]

**描述**：app 配置页与 dev 配置页从 v0.0.3/v0.0.4 单栏纵向堆叠改为**三栏**布局；配置区域每 key 一张卡片；每个 group 一个独立「保存」按钮。两页结构一致，共用组件。
**优先级**：P0
**用户故事**：作为用户，我希望按 group 分组浏览配置、改完一个 group 单独保存，避免误改其他 group、避免「整页保存」的副作用。

**期望行为**：
- **布局**：`功能导航（56px nav-rail）` + `group 列表` + `配置区域`。
  - **group 列表（common/section-group-list）**：列出所有 group（app config 如 `appearance` / `providers`；dev config 如 `llm_request`）。点击切换右侧配置区域；选中项左竖条 + 浅底（terracotta）。
  - **配置区域（section-config-layout）**：选中 group 下所有 key，每 key 一张 `component-key-card`（key 名 + 说明 + 控件：primitive-key-input / -select / -boolean）。
  - **每 group 保存条（component-group-save-bar）**：固定在配置区域底部，含「保存该 group」按钮。有未保存改动 → 按钮高亮 + 「●」标记；无改动 → 按钮 disabled/灰态。
- **app 配置页特有**：`appearance` group（theme 选项框，dark/light，切立即生效）+ `providers` group（v0.0.4 挪入；**v0.0.7 重做**为三级流：list → provider 二级页 → model 弹层，唯一保存在二级页，详见 §3.9.7）+ **`locale` group `[v0.0.59]`**（语言选择器卡片：`primitive-key-choice-cards` 两选项「中文」/「English」，切即生效 + PUT 持久化，对齐 appearance.theme 模式；选项 label 自指——「中文」恒显「中文」、「English」恒显「English」，不随 locale 切换变化。技术权威 `specs/tech/i18n/[P0]i18n_overview.md`，UI 契约 `specs/ui/overall/03-config-center.md §2.3a`，i18n 全景 `specs/prd/version_logs/v0.0.59.i18n.md`）+ **`user_memory` group `[v0.0.55]`**（全局长期记忆，自渲染 `<SectionUserMemory/>`，无底部 save-bar）+ **`web_search` group `[v0.0.72]`**（网络搜索 provider 路由 + 凭证，自渲染 `<SectionWebSearchConfig/>`，无底部 save-bar，type choice-cards + 动态 credentials + saveMode='item'，详见 `specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md`；技术权威 `specs/tech/config/[P0]app_config.md §3.6`，工具路由 `specs/tech/agent/tools/[P1]web_search_tool.md §3/§4`）。
- **dev 配置页**：`llm_request` group（`stall_timeout_s` 数字 + `max_retry_times` 数字）+ `observability` group `[v0.0.11]`（list-of-objects，见 §3.9.8）+ `logs` group `[v0.0.30]`（4 个 boolean 调试日志开关，控制对应调试流量追加写 `<DATA_DIR>/logs/<type>.log`，普通 KV group 走既有 key-card boolean toggle，hook 契约见 `specs/tech/dev-logs/[P0]overall.md`）。
- **保存语义**：点「保存该 group」→ 提交**仅该 group 全部 key**（SET /config/app 或 /config/dev 带 group 参数，后端细节归 specs/api/）。其他 group 改动不提交。
- **窄屏适配**：窄屏 group 列表收起为抽屉（hamburger 入口）。
- **数据源**：`GET /config/app` / `GET /config/dev`（group → keys）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.9.2.1 | nav-rail 点「app」→ 看三栏（功能导航 + group 列表 + 配置区域） | 三栏渲染；group 列表含 appearance/providers；配置区域默认显示首个 group |
| UC-3.9.2.2 | group 列表点 `llm_request` → 配置区域切换到该 group 的 key 卡片 | 仅该 group 的 key 渲染为独立卡片；选中 group 左竖条 |
| UC-3.9.2.3 | 改 `llm_request.stall_timeout_s` 从 30→45 → 该 group 保存条高亮 + 「●」 | 脏状态可见；其他 group 不受影响；布局无位移 |
| UC-3.9.2.4 | 点「保存该 group」→ 仅提交 llm_request group | 后端收到 group=llm_request + 全部 key；其他 group 改动未提交；保存条恢复干净态 |
| UC-3.9.2.5 | 改 group A 的 key、不保存 → 切到 group B → 再切回 A | group A 改动仍在（未保存）；group B 干净 |
| UC-3.9.2.6 | appearance.theme 切 dark → 整个应用视觉切深色 → 刷新仍 dark | theme 即时生效 + 持久化（沿用 UC-3.7.2） |

---

## 3.9.3 plugin config 页 · 插件 tab [v0.0.5]

**描述**：plugin config 页顶部 2 tab（插件 / 扩展点）。**插件 tab** 是纯 plugin 列表，每行 `component-plugin-item`（名称 + 描述 + enabled 开关），**每个 plugin 开关完全独立**（修复 v0.0.4「两 plugin 开关联动」bug）。本 tab 不管理 ext impl（impl 在扩展点 tab）。
**优先级**：P0
**用户故事**：作为用户，我希望单独控制每个插件的启停，互不影响，不被联动 bug 干扰。

**期望行为**：
- **tab 切换**：顶部 `插件` / `扩展点` 两 tab，点击切换主区内容；当前 tab 有视觉强调（terracotta 下划线/底色）。
- **插件列表（section-plugin-list）**：每行 `component-plugin-item`，左侧 plugin 名称（主）+ 描述（副，灰），右侧 enabled 开关（`primitive-toggle-switch`）。
- **开关独立（核心约束）**：每个 plugin 开关 state 独立，互不联动。切 plugin A 的开关**绝不**影响 plugin B 的开关状态。实现层：每个 plugin 一份独立 state slice（详见 `component-plugin-item.md` 状态章节）。
- **开关后端**：`SET /config/plugin` `setEnabled(pluginId, enabled)`。立即生效 + 持久化。
- **不在此 tab**：ext impl 的 enabled / 排序 / schema config —— 全在扩展点 tab。
- **数据源**：`PluginConfigService.inventory()` 顶层 plugins 列表（pluginId + label + description + enabled）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.9.3.1 | nav-rail「插件」→ 顶部两 tab，默认插件 tab | 插件 tab 选中态；插件列表渲染（每行名称+描述+开关） |
| UC-3.9.3.2 | 切 plugin A 开关 OFF → 看 plugin B 开关 | plugin B 开关**不变**（独立，无联动） |
| UC-3.9.3.3 | 切 plugin A 开关 ON → plugin B 开关 OFF（原本 ON）→ 再切 A OFF | B 保持 OFF，A 切回 OFF；两开关完全独立可分别操作 |
| UC-3.9.3.4 | 切某 plugin 开关 → 重启应用 → 读回 | 状态持久化（plugin.enabled 落盘） |
| UC-3.9.3.5 | 切「扩展点」tab 再切回「插件」tab | 插件列表状态保持（含刚改的开关态）；不重置 |

---

## 3.9.4 plugin config 页 · 扩展点 tab（ext type 分化） [v0.0.5]

**描述**：扩展点 tab 主区**两栏**：左 group 列表（common/section-group-list，扩展点按 EP.group 归类，沿用 v0.0.4 §3.8），右选中 group 下所有扩展点及其 impl（`section-ext-point-area`）。**每个扩展点带 type 标签，按 type 渲染不同选择控件**。
**优先级**：P0
**用户故事**：作为用户，我希望按扩展点的语义（互斥/列表/有序）用对应的交互方式管理 impl，而不是统一一个 toggle。

**期望行为**：
- **左栏 group 列表**：来自 `PluginConfigService.inventory()`（group-centric，§3.8）。如 group=`provider` 下含 `llm_provider` + `llm_protocol` 两个扩展点。点击切换右栏；选中左竖条 + 浅底。
  - **[v0.0.13 修订]** group 列表新增 `context` group（数据层新增，UI 渲染规则完全不变）。其下 6 个扩展点全部 `cardinality: ordered`（context_ingest_handler / context_assemble_mapper / context_assemble_reducer / system_prompt_mapper / system_prompt_reducer / system_reminder），由 builtin plugin `rocky_context` 声明共 26 个 ext impl，UI 自动按既有 ordered 渲染（拖拽手柄 + enabled 开关 + 有 schemaConfig 的显「配置」齿轮）。新增 testid 遵循现有规则（`ext-point-{pointId}` / `ext-impl-{implId}` / `-drag` / `-toggle` /（仅 5 个有 config schema 的）`-config-btn`）。详见 `03-llm-chat.md` §4 路径 N。
- **右栏扩展点区（section-ext-point-area）**：按扩展点分组折叠，每个扩展点带 `type` 标签（exclusive/list/ordered），按 type 渲染：
  - **exclusive（`component-ext-impl-radio`）**：每项前 radio。选中其一 → 该项 enabled，**同扩展点其余 impl 自动 disable**（变灰）。语义：互斥选择（如 chat_model 选 anthropic 或 openai，二选一）。**`[v0.0.55 modified]`** exclusive EP 机制统一：废弃后端 `exclusive` 字段，统一用 `enabled + order`——`setExclusive` 改 enabled 互斥、`exclusivePick` 改读 enabled + effective order 最小、inventory 投影派生 `selected`（前端不再自算）。修前后端字段脱节 bug（多红框 / radio 一个 dot / 切不生效 / 静默切坏 default scope）。详见 `specs/prd/version_logs/v0.0.55.memory_ui_session_lock/change_log.md` §2.6。
  - **list（`component-ext-impl-checkbox`）**：每项前 checkbox，独立勾选/取消。语义：可同时启用多个（如多个 retriever）。
  - **ordered（`component-ext-impl-ordered`）**：每项前拖拽手柄（`primitive-drag-handle`，可上下拖动排序）+ 独立 enabled 开关（`primitive-toggle-switch`）。**排序与开关互不干扰**：拖动改 order 不改 enabled；切 enabled 不改 order。语义：有序执行链（如 pipeline）。
- **[v0.0.18] EP header 加 `pointDescription`**：扩展点标题区显示该 ext point 的 description（来自 `ExtensionPoint.description`，代码硬编码，inventory 透传，缺省空串不渲染），帮助用户理解该扩展点干什么。
- **[v0.0.18] impl 行加 `description`**：implId 主标题下副文本显示该 impl 的 description（来自 `ExtImpl.description`，代码硬编码，缺省空串不渲染）；适用 exclusive/list/ordered 三种 impl 组件。
- **impl 行信息**：implId（主）+ pluginId（副灰）+ pointId（标签）；有 schemaConfig 的 impl 末尾「配置」齿轮入口（见 §3.9.5）。
- **后端**：
  - exclusive：`SET` selected implId → 该扩展点其余 impl enabled=false。
  - list：`SET` 各 impl enabled 独立。
  - ordered：`SET` 各 impl order + enabled 独立（两字段）。
- **[v0.0.18] 拖拽持久化语义**：ordered 扩展点拖动后，前端**整个 ext point 组一起**发 `setPointOrders(pointId, orders[])` 批量 op（替代旧单条 `setOrder`），根治「只写一条」bug；落盘后**刷新页面顺序不变**（GET 返回 effective order 与拖动后一致）。
- **布局稳定性**：拖拽排序用 transform / 预留高度，禁导致跨行位移（沿用 §2.3）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.9.4.1 | 扩展点 tab → group 列表点 `provider` → 右栏见 llm_provider + llm_protocol 两扩展点 + type 标签 | 两栏渲染；每扩展点带 type 标签（如 exclusive）；impl 行含 implId/pluginId/pointId |
| UC-3.9.4.2 | exclusive 扩展点：radio 选 impl A（原选 B） | A 变 enabled/选中；B 自动 disable 变灰；同扩展点仅一个 enabled |
| UC-3.9.4.3 | list 扩展点：勾 impl A、不勾 impl B → 各自独立 | A enabled、B disabled；勾选互不影响；可同时多选 |
| UC-3.9.4.4 | ordered 扩展点：拖 impl A 从 order=0 到 order=2 → A.enabled 保持原值 | 排序变更（order 重排），enabled 状态不变（排序与开关互不干扰） |
| UC-3.9.4.5 | ordered 扩展点：切 impl A 开关 OFF → 其他 impl 的 order 不变 | enabled 切换不影响 order；其他 impl 顺序稳定 |
| UC-3.9.4.6 | 任一扩展点 impl 操作 → 重启 → 读回 | 状态持久化（selected/enabled/order 落盘） |

---

## 3.9.5 impl schema config 弹层 [v0.0.5]

**描述**：impl 若声明 `schemaConfig`（key→{type, default, options?...}），impl 行末尾出「配置」齿轮入口，点击打开弹层（`component-schema-config-modal`）。弹层内控件**由 schema.type 驱动**渲染：string→输入框 / number→数字框 / boolean→开关 / enum→下拉 / object→分组。弹层内独立保存/取消，不影响外层 impl 的 enabled/order。
**优先级**：P0
**用户故事**：作为用户，我希望对有配置项的 impl 单独配置参数（如 apiKey、model、temperature），且配置独立于启停/排序。

**期望行为**：
- **入口**：impl 行末尾齿轮按钮，仅当该 impl 有 schemaConfig 时出现；hover 出现不导致位移（预留槽位）。
- **弹层内容**：标题 = implId + pointId；按 schemaConfig 的 key 顺序渲染控件（每 key 一行：label + 控件）。
  - type=string → `primitive-key-input`（text）
  - type=number → `primitive-key-input`（number）
  - type=boolean → `primitive-key-boolean`（switch）
  - type=enum → `primitive-key-select`（dropdown，options 来自 schema）
  - type=object → 分组容器，内嵌上述控件
- **默认值**：未配置时控件显示 schema.default（来自代码默认，overlay 模型）。
- **保存语义**：弹层「保存」→ `SET` impl config（`setImplConfig(pluginId, pointId, implId, values)`），仅该 impl 的 configValues 落盘。「取消」→ 关闭不保存。保存/取消均不触碰 enabled/order。
- **遮罩与关闭**：弹层背景遮罩，点遮罩或 Esc = 取消（不保存）；布局稳定性：弹层用 fixed/absolute，不影响下层布局。
- **数据源**：impl schemaConfig（声明期）+ config record（稀疏 delta，overlay 默认值）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.9.5.1 | 扩展点 tab → 有 schemaConfig 的 impl 行 → 见末尾「配置」齿轮 | 仅该 impl 行有齿轮入口；无 schemaConfig 的 impl 无齿轮 |
| UC-3.9.5.2 | 点齿轮 → 弹层打开 → 控件按 schema.type 渲染（string/enum/...） | 每个 schema key 一个对应控件；默认值来自 schema.default |
| UC-3.9.5.3 | 改 apiKey=sk-xxx + model=claude-sonnet → 保存 | 弹层关闭；configValues 落盘；外层 enabled/order 不变 |
| UC-3.9.5.4 | 改值 → 取消（或 Esc / 点遮罩） | 弹层关闭；改动不落盘；下次打开仍是旧值 |
| UC-3.9.5.5 | 保存后重启 → 再次打开该 impl 配置弹层 | 读回上次保存的值（持久化） |

---

## 3.9.6 关键用户路径（MANDATORY — 测试最低覆盖） [v0.0.5]

> 以下 6 条路径 = 本版本测试的最低覆盖要求。每条至少一个 API + E2E case。路径编号 = test-plan.md 路径→case 映射的 key。

### 路径 1：app/dev config 三栏 + group 独立保存
- 链路：选 group → 改某 key 卡片 → 点该 group「保存」→ 仅该 group 提交。
- 关键断言：保存只影响被保存的 group，其他 group 改动不串扰。
- UC: UC-3.9.2.2 + UC-3.9.2.3 + UC-3.9.2.4。

### 路径 2：plugin 插件 tab 开关独立（修复 v0.0.4 联动 bug）
- 链路：切某 plugin 开关 → 仅该 plugin 变化，其他 plugin 不受影响。
- 关键断言：plugin A 开关变化时 plugin B 开关保持原值（bug 回归验证）。
- UC: UC-3.9.3.2 + UC-3.9.3.3。

### 路径 3：扩展点 tab · exclusive（radio 互斥）
- 链路：互斥扩展点 radio 选 impl A → A 启用、同扩展点其余 impl 自动 disable。
- 关键断言：同扩展点仅一个 enabled，其余变灰。
- UC: UC-3.9.4.2。

### 路径 4：扩展点 tab · list（checkbox 独立）
- 链路：list 扩展点勾选/取消 impl → 各自独立。
- 关键断言：勾选互不影响，可同时多选。
- UC: UC-3.9.4.3。

### 路径 5：扩展点 tab · ordered（拖拽 + 独立开关互不干扰）
- 链路：拖拽 impl 排序 + 各 impl 独立开关（两者互不干扰）。
- 关键断言：order 变更不改 enabled；enabled 变更不改 order。[v0.0.18] 拖动后整个 ext point 组批量持久化（`setPointOrders`），**刷新页面顺序不变**；EP header / impl 行展示三级 description（plugin / ext point / ext impl）。
- UC: UC-3.9.4.4 + UC-3.9.4.5。

### 路径 6：impl schema config 弹层
- 链路：点 impl「配置」→ 弹层按 schema 渲染控件 → 编辑 → 保存。
- 关键断言：控件由 schema.type 驱动；保存只落 configValues，不动 enabled/order。
- UC: UC-3.9.5.2 + UC-3.9.5.3 + UC-3.9.5.4。

---

## 3.9.7 providers group 三级流 + diff-save（v0.0.7 重做） [v0.0.7] [v0.0.53 modified]

> 重做 §3.9.2 路径 1 中 providers group 的「配置区」交互。数据归属不变（app_config providers group record），端点不变（`/provider` + `/provider/:id/model`，见 `specs/api/overall/02-llm-chat.md` §5）。本节只重定义**交互模型**。
> 权威组件 spec：`specs/ui/components/providers/_overview.md`。
>
> **[v0.0.53 modified] protocol 归属迁移（model→provider）+ protocol 下拉 + 拼接地址动态展示**：
> - `protocolId` 字段从 `ModelInstance` **彻底迁到** `ProviderInstance`（锁 1 provider : 1 protocol，单一事实源）。理由：protocol impl 挂 path，path 必须与 baseUrl 在一起才有意义；一个 provider 若支持多 protocol，每个 protocol 对应不同 baseUrl，无法共享 → 1:1 锁定。详见 `specs/prd/version_logs/v0.0.53.protocol_opt/change_log.md`。
> - **provider 二级页 `component-provider-fields` 加 `protocol` 下拉**（testid `provider-field-protocol`，选项来自 `PluginManager.getExtensionImpls("llm_protocol")` × `{id, label}`，展示 `label` 持久化 `id`）+ **「实际请求地址」mono 展示区**（`baseUrl + protocol.path`，随两字段实时变化，read-only）。例：`https://api.anthropic.com` + `/v1/messages` → `https://api.anthropic.com/v1/messages`。
> - **model 编辑弹层移除 `protocolId` 字段**（v0.0.7 spec 中 protocolId「固定不可编辑」，v0.0.53 起该字段不存在于 model，protocol 选择改在 provider 二级页）。
> - 数据迁移：dev/test 现有 4 provider（minimax/volcengine/glm/deepseek）启动时自动补 `protocolId=anthropic_messages`（从其任一 model 抄过来，本就同值无歧义）；models[] 移除 protocolId 字段。
> - API 契约：`ProviderInstance` += `protocolId`（必填）；`ModelInstance` −= `protocolId`；`POST /provider` 必须带 `protocolId`（缺省 400），`POST /provider/:id/model` 不再接受 protocolId。

**设计原则（v0.0.7）**：
1. **唯一保存按钮在 provider 二级页**（testid `provider-save`）：provider 字段 + 所有关联 model 的增删改**一起保存**。
2. **三级导航 + 弹层**：`list（provider 卡 + 添加提供商虚线卡）→ provider 二级页（连接配置 + 关联 model 列表 + 添加模型 + save-bar）→ model 弹层（确定/取消）`。model 弹层底部是「确定」**不是**「保存」——确定仅把字段回写到 draft，不触后端。
3. **前端 diff-save 编排**：点二级页「保存」→ 前端 UI 算 diff → 逐条调后端 CRUD（provider POST/PUT + model POST/PUT/DELETE by modelId）。后端端点不变。
4. **ModelInstance 字段外显**：每个 model 卡外显 `label`（显示名）+ `modelId`（mono）+ `default` 徽章 + `enabled` 徽章 + `contextWindow`/`maxOutputTokens` mono 副标。
5. **ProviderInstance 字段外显**：每个 provider 卡外显首字母 logo + `label` + `enabled` 徽章 + `baseUrl` + 模型数。

**关键用户路径**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.9.7.1 | app config → providers group → 点「添加提供商」虚线卡 | 进 provider 二级页（pid='new'，label/baseUrl/apiKey 空，models=[]） |
| UC-3.9.7.2 | 二级页填 label/baseUrl/apiKey → 点「添加模型」→ model 弹层填字段 → 点「确定」→ 看 model 卡出现在 draft 列表 → 点「保存」 | 后端 POST /provider + POST /provider/:id/model；reload 后 list 出现新 provider；返回 list |
| UC-3.9.7.3 | 进已存 provider 二级页 → 改 label → 改某 model 的 contextWindow（弹层确定回写）→ 删另一 model → 点「保存」 | 前端 diff：PUT /provider/:id（label）+ PUT /provider/:id/model/{mid}（ctx）+ DELETE /provider/:id/model/{mid2}；reload 后 list 反映最新状态 |
| UC-3.9.7.4 | 进二级页改字段不保存 → 返回（或面包屑回 list） | draft 丢弃（未保存不入库）；list 显示原值 |
| UC-3.9.7.5 | 进二级页改字段 → dirty 指示显「● 有未保存的更改」 → 点保存成功 → dirty 变「✓ 已保存」 | dirty 状态正确反映 draft/snapshot diff |
| UC-3.9.7.6 [v0.0.53] | 新建 provider → 填 label/baseUrl/apiKey → **选 protocol 下拉** → 看「实际请求地址」随 baseUrl 与 protocol 实时拼接（如 `https://api.anthropic.com/v1/messages`）→ 添加 model（弹层无 protocolId）→ 保存 | 后端 `POST /provider`（含 protocolId）+ `POST /provider/:id/model`（无 protocolId）；reload 后 list 反映新 provider；实际 chat 验证 url = `baseUrl + protocol.path` |
| UC-3.9.7.7 [v0.0.53] | 进已存 provider 二级页 → 改 baseUrl → 看「实际请求地址」实时变化 → 保存 | PUT /provider/:id（baseUrl）；实际 chat 走新拼接 url |
| UC-3.9.7.8 [v0.0.53] | 升级前 dev/test 现有 provider+model → 升级后启动 → 进二级页 | provider 二级页 protocol 下拉默认显示 `anthropic_messages`；model 列表与弹层无 protocolId 字段；现有 session 继续可 chat（迁移透明） |
| UC-3.9.7.9 [v0.0.53] | 进 model 编辑弹层 | 字段中无 protocolId（v0.0.53 起从 model 移除，protocol 改在 provider 二级页选） |

> **新增 model 字段（v0.0.7）**：`ModelInstance` 新增 `label: string`（POST 缺省 = modelId）+ `enabled: boolean`（POST 缺省 = true）。`label` 用于区分同 provider 下多个 model；`enabled=false` 的 model 在 chat 模型选择器隐藏。
>
> **[v0.0.53 modified] 字段归属变更**：`protocolId` 从 `ModelInstance` 移到 `ProviderInstance`（必填）。`component-provider-fields` 加 protocol 下拉 + 拼接地址展示（testid `provider-field-protocol`）；`component-model-edit-modal` 字段列表移除 protocolId。后端 `LlmClient` url 拼接的 `protocol.path` 来源从 modelConfig 切换到 providerConfig；`llm-client-factory.ts` 按 `providerConfig.protocolId` 动态取 impl（替代硬编码 `anthropic_messages`）。详见 `specs/prd/version_logs/v0.0.53.protocol_opt/change_log.md`。

---

## 3.9.8 可观测性配置（dev config · observability group，list-of-objects） [v0.0.11]

> dev config 页新增 `observability` group，结构不同于普通 key-value group（多 backend 实例列表）。权威组件 spec：`specs/ui/components/app-dev-config-page/observability-config/`。tech：`specs/tech/agent/observability/[P0]observability_manager.md`。
> **概念边界**：UI 只管配置 CRUD + 启停；observability manager（异步/容错/多实例 fan-out）= tech 范畴；agent loop 接入归 tech（manager 对 loop 透明，埋点零改动）。

**设计要点（v0.0.11）**：
1. **list-of-objects group**：observability 是列表（多 backend 实例，dev 可配多条：self-host + cloud 双写、staging/prod 隔离），每项独立 id/启停/删除。当前 type 仅 `langfuse`，预留扩展。
2. **list / detail 两视图分支**：list = 标题 + provider-card 列表 + 添加卡 + 删除 modal；detail = breadcrumb + 头部（logo+name+type+toggle）+ 基础信息 section + 认证密钥 section + **物理层记录 section（v0.0.50 新增）** + save-bar。
3. **name + type 竖排各占一行**（用户决策，对设计稿 f-row-inline 横排的修正）；type 只读 `langfuse`。
4. **enabled toggle 即时生效**（不进详情、不计 dirty）；改字段 → dirty 指示 → 保存 / 重置。
5. **secretKey password 脱敏展示**；后端 GET redact `"***"`、PUT 占位 merge（见 `specs/api/overall/03-config-center.md §3.5`）。
6. **logPhysical 开关（v0.0.50 新增）**：每 item 加 boolean `logPhysical`（默认 off），位于「认证密钥」section 之后的独立「物理层记录」section，label「双重记录」+ hint `logPhysical` + hover tooltip（PrimitiveTooltip）说明「开启后每次 LLM 调用并列记录两条 generation：logical（业务视图）+ physical（wire body）。physical 不带 usage，不污染 token/cost 统计。默认关闭。改动重启或新会话生效。」；testid `obs-field-logphysical`（+ row/info/-tooltip）。**计 dirty**（需点保存，与 enabled 即时生效不同）；**改动不热更新**（与列表本身语义一致）。详见 `specs/ui/components/app-dev-config-page/observability-config/section-observability-detail.md`。

**关键用户路径**（= 测试最低覆盖）：

| ID | 路径 |
|----|------|
| UC-OBS-1 | dev config → 左栏 `observability` group → 右侧列表（标题 + 现有项 + 添加卡） |
| UC-OBS-2 | 列表「添加配置」→ 详情（新建）→ 填表 → 保存 → 返回列表见新项 |
| UC-OBS-3 | 列表点项 → 详情（编辑）→ 改 baseUrl → dirty → 保存 → 已保存 |
| UC-OBS-4 | 列表点项 toggle → 即时启停（不进详情、不弹确认、不计 dirty） |
| UC-OBS-5 | 列表点项删除 → modal 确认 → 列表移除 |
| UC-OBS-6 | 详情改字段 → 重置 → dirty 清除 |
| UC-OBS-7 | 详情头部 toggle → 即时启停（不计 dirty） |
| UC-OBS-8 | （生效路径）启用某项 → 重启/下 session → agent loop 经 manager 异步上报，失败不影响主流程 |
| UC-OBS-9 | （v0.0.50）详情开启「双重记录」logPhysical 开关 → dirty → 保存 → 重启 → 每次 LLM 调用 langfuse 出现并列 `llm-N-logical` + `llm-N-physical` 两条 generation（physical usage=0） |

> **配置不热更新**：改列表（增/删/改/启停）→ 写 app_config（runtime 组，v0.0.89 迁自废弃 dev_config）→ 当前进程 manager 不变，重启 / 下个 session 生效（UI 提示「重启生效」）。理由见 tech `observability_manager.md §7`（manager 持 langfuse client 中途替换会丢 batch / 串 handle）。

---

## 3.9.9 扩展点 tab · scope 切换器（v0.0.26 plugin-by-scope） [v0.0.26]

> ext-impl 配置层引入正交维度 `scope`（agent loop 风格，与 `ExtensionPoint.group` 功能分区正交）。权威 spec：`specs/tech/config/[P0]ext_impl_scope.md`（D1-D6 决策）。本节是 §3.9.4（扩展点 tab）的 scope 维度增量（不重写既有 ext type 渲染）。
>
> **scope 产品概念**（一句话）：scope 是 ext-impl **配置层**正交维度（运行时可切的 agent loop 风格），每个 scope 独立持有 enabled/order/configValues 一份；`default` 全 EP 永远激活基线，其他 scope per-EP 激活（激活初始值复制 default snapshot 后独立），未激活 EP 运行时回退取 default。

**设计原则（v0.0.26）**：
1. **scope 切换器位置**：扩展点 tab **顶层**（在两栏 group 列表 + ext point 区之上）挂 `component-scope-switcher`（权威 spec：`specs/ui/components/plugin-config-page/component-scope-switcher.md`）。**插件 tab 不受 scope 影响**（plugin 级配置不分 scope，PRD OUT）。
2. **per-EP 继承 + 激活**：default scope 全 EP 永远激活（全亮可操作）；其他 scope 默认全 EP 未激活（灰显 + 「继承 default」提示 + 「激活此 EP」按钮）；激活初始值复制 default 当前 snapshot（之后独立，default 改动不传导）；取消激活清配置回退。
3. **激活粒度 = EP**：每个 EP 独立激活/继承（不做跨 EP 批量激活，PRD OUT）；激活/取消激活按钮固定在 EP header 右侧（`visibility:hidden` 预留空间避免位移）。
4. **scope 一等实体**：可创建（id + name + description）/ 删除（非 default，cascade 清其 per-EP 配置）；default 不可删也不提供删除入口。
5. **调用方自决 scopeId**：UI 切 scope 只影响展示与配置面；**本版本不做 scope 选择逻辑**（agent loop 怎么选 scope 留后续版本）。

**期望行为（关键交互）**：
- 切 scope S → 下方每 EP 显示 S 视图（未激活 EP 灰显 + 取 default 配置视图 + 「激活此 EP」按钮；已激活 EP 显示 S 独立配置 + 「取消激活」按钮）。
- 点「激活此 EP」→ POST activate → 复制 default snapshot → EP 转可操作（显示 S 独立配置）→ 改 impl 开关/顺序/configValues 反映到 S。
- 点「取消激活」→ 二次确认 modal（破坏性操作对齐 `component-scope-delete-modal` 模式，不用 `window.confirm`）→ DELETE activate → EP 灰显回退继承 default。
- 创建 scope → dropdown 内联输入 → POST scope → 列表含新 scope → 自动选中。
- 删除非 default scope → 确认 → DELETE → 列表移除；若删的是 currentScopeId 则切回 default。

**关键用户路径（v0.0.26 增量，MANDATORY 测试最低覆盖）**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.9.9.1 | 打开扩展点 tab → 顶层 scope 切换器可见，当前=default | 切换器在顶层；下方 EP 全亮可操作 |
| UC-3.9.9.2 | scope 切换器选「custom」→ 下方所有 EP 灰显 + 「继承 default」+「激活此 EP」按钮；布局无位移 | 切 scope 后正确反映继承态；按钮出现/消失不导致位移 |
| UC-3.9.9.3 | scope=custom 下点某 EP「激活此 EP」→ EP 转可操作（显示 custom 独立配置）→ 改 impl 开关 → 刷新仍保持 → API 反映改动 | 激活 + 改配置 + 持久化链路通 |
| UC-3.9.9.4 | scope=custom 已激活 EP 下点「取消激活」→ 确认 modal → EP 灰显继承 default | 取消激活 UI 正确回退 |
| UC-3.9.9.5 | scope 切换器创建新 scope → 切换器列表含新 scope | 创建 scope UI 通 |
| UC-3.9.9.6 | scope 切换器删除非 default scope → 确认 → 列表移除；default 无删除入口 | 删除 scope UI 通 + default 保护 |

> **本版本无设计稿**（`hasDesign=false`）。视觉保真度门禁跳过；E2E 仅做单图功能检查（切换器可见/选中态正确/灰显-激活态正确/布局无位移）。视觉风格遵循既有 plugin-config-page（terracotta 强调色 / 卡片 / 折叠分组），scope 切换器视觉基线见 `component-scope-switcher.md`。

---

## 3.9.10 设置入口三合一（v0.0.47 — app+dev+插件 合为「应用设置」+ SKILLS/连接器 独立） [v0.0.47]

> 本节是 v0.0.47 配置入口重组的产品需求：合并 app config + dev config + 插件 三页为单一「应用设置」入口；SKILLS + 连接器 恢复为 nav 底部独立入口。**配置数据结构零修改**（仅入口合并 + 路由收敛），各 tab 内容沿用 §3.9.2（app/dev config 三栏 + group 独立保存）/ §3.9.3-§3.9.5（插件两 tab + ext type 分化）/ §3.9.9（scope 切换器）既有行为。
> 权威设计 = `reqs/v0.0.47.ui_opt/req.md`；详见 `version_logs/v0.0.47-ui_opt/change_log.md`。无设计稿 → 视觉保真度门禁跳过。

**设计原则（v0.0.47）**：
1. **入口收敛**：原 nav 齿轮子菜单 5 项（用户/插件/系统/Skill/连接器，v0.0.33.1 折叠）→ 拆分重组——app/dev/plugin 三合一为「应用设置」单入口；Skill + 连接器 恢复为 nav 底部独立入口（v0.0.33.1 折叠前的状态，但放在 nav 底部而非原独立 nav 项）。
2. **nav 底部三入口（自上而下）**：SKILLS（testid `nav-skill`）/ 连接器（testid `nav-connector`）/ 应用设置（testid `nav-settings-app`）。**移除齿轮按钮**（`nav-settings-group` / `nav-settings-group-menu` / `nav-settings-mask` 整体删除）。
3. **应用设置合并页（新 view id `'settings-app'`）**：**[v0.0.47 Bug B 重构]** ONE `SectionConfigLayout`，**无顶部横排 tab 栏**——左侧 sidebar（group 列表）即唯一导航：**app config 常驻组**（appearance/providers/locale/user_memory/web_search，**`web_search` 为 `[v0.0.72]` 新增自渲染 group，位于 providers 之后**）→ **「展开/收起系统配置」分割线 toggle**（testid `app-settings-system-toggle`，默认收起）→ 展开后露出 **dev config 组**（llm_request/observability/logs）+ **插件组**（特殊，最后）。右侧 = 当前选中 group 的配置区；插件组选中 → 右栏渲染**完整** `<PagePluginConfig/>`（保留其内部 插件/扩展点 子 tab + scope 切换，不拆散）。视觉契约 `reqs/v0.0.47.ui_opt/app-settings-layout-mockup.html`。
4. **默认收起系统配置**：打开应用设置默认 sidebar 只显 app config 组（用户视角 = 简单配置页）；点分割线 toggle 才在 sidebar 内露出 dev 组 + 插件组。收起时若当前选中 ∈ {dev 组/插件}，回落到 `appearance`。
5. **各 group 内容零修改**：app/dev KV 组走 `section-config-layout`（group 列表 + 配置区 + key-card）+ group 独立保存（§3.9.2）；providers/observability 自渲染（§3.9.7 / §3.9.8）；user_memory 自渲染（§3.9.11 若有）；**[v0.0.72] `web_search` 自渲染 `<SectionWebSearchConfig/>`**（type choice-cards + 动态 credentials + saveMode='item'，详见 `specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md`）；插件组内嵌整页 `page-plugin-config` 两 tab（§3.9.3-§3.9.5 + §3.9.9 scope 切换器）。
6. **路由收敛**：`'settings-dev'` / `'settings-plugin'` view id **废弃**（合并入 `'settings-app'`）；`'skill'` / `'connector'` view id 沿用。
7. **布局稳定性（沿用 §2.3 MANDATORY）**：system-toggle 分割线展开/收起导致 dev 组 + 插件组在 sidebar 内出现/消失——分割线 + toggle 按钮固定占位，只切文案 + chev rotate，零布局位移；右栏配置区按选中 group 切换。

**期望行为（关键交互）**：
- nav 底部点「应用设置」→ 进入合并页，默认选中 app config 首个 group（`appearance`），右栏配置区渲染对应内容。
- 点 sidebar 的 app config group（如 `providers`）→ 右栏切换（沿用 §3.9.2 / §3.9.7 providers 三级流）。
- 点 sidebar 内「展开系统配置」分割线 toggle → 下方 dev config group + 插件 group 在 sidebar 露出（布局无位移）。
- 点 dev config group（如 `llm_request`）→ 右栏切换到 dev 配置（沿用 §3.9.2 dev 配置页行为）。
- 点插件 group → 右栏切换到插件配置（整页 `<PagePluginConfig/>`：插件/扩展点 子 tab + §3.9.9 scope 切换器，不拆散）。
- 再次点分割线 toggle → dev group + 插件 group 在 sidebar 收起；若当前选中 ∈ {dev/插件}，回落到 `appearance`。
- nav 底部点 SKILLS → 切到 `view='skill'`（`page-skill`）；点连接器 → 切到 `view='connector'`（`page-connector`）。

**关键用户路径（v0.0.47 增量，MANDATORY 测试最低覆盖）**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.9.10.1 | 打开应用 → 看 nav 底部 | 自上而下三项：SKILLS / 连接器 / 应用设置（无齿轮子菜单） |
| UC-3.9.10.2 | 点 nav 底部「SKILLS」 | 切到 skill 页（view='skill'） |
| UC-3.9.10.3 | 点 nav 底部「连接器」 | 切到 connector 页（view='connector'） |
| UC-3.9.10.4 | 点 nav 底部「应用设置」 → 默认 sidebar 只显 app config group | 默认选中 `appearance` group，右栏配置区渲染 |
| UC-3.9.10.5 | 应用设置页 → 点「展开系统配置」分割线 toggle（testid `app-settings-system-toggle`） | sidebar 露出 dev config group + 插件 group；布局无位移 |
| UC-3.9.10.6 | 承上 → 点 dev config 的 `llm_request` group（`group-item-llm_request`） | 右栏切换到 llm_request 的 key-card 列表（沿用 dev 配置行为） |
| UC-3.9.10.7 | 承上 → 点插件 group（`group-item-plugin`） | 右栏切换到完整插件配置（`<PagePluginConfig/>` 的插件/扩展点 两 tab + scope 切换器） |
| UC-3.9.10.8 | 应用设置页（展开态）→ 再点分割线 toggle | dev group + 插件 group 收起；当前若选中 dev/插件 → 回落 `appearance` |
| UC-3.9.10.9 | 应用设置页改某 app key → 保存 → 重启 → 再打开应用设置 | 改动持久化（沿用 §3.9.2 group 独立保存行为） |

> **设计稿**：v0.0.47 task3 无设计稿（视觉保真度门禁跳过）；**v0.0.47 Bug B 引入** `reqs/v0.0.47.ui_opt/app-settings-layout-mockup.html` 作为统一 sidebar 重构的**布局视觉契约**（定义 sidebar 内 group 列表 + 分割线 toggle + 插件整页内嵌结构）。E2E 覆盖三入口可见 / sidebar group 切换 / 分割线 toggle 展开-收起 / 插件 group 内嵌整页 / 布局无位移。视觉风格遵循既有 config-page（terracotta 强调色 / 卡片 / 分组）。
>
> **OUT OF SCOPE（v0.0.47 配置域）**：配置数据结构/字段迁移（零修改）；scope 切换器 / ext type 分化 / group 独立保存等既有行为不动（仅在合并页内复用）。

---

## 3.9.11 整理 tab（consolidation group — 天级二级整理配置 + 手动触发） [v0.0.151.t2_consolidate] [v0.0.205.t2_cons modified]

> 应用设置「整理」tab（系统设置收起区，与 observability/plugin 同级）= 天级二级整理任务的配置 + 触发面板。数据 = `app_config.consolidation` record（enabled/dailyTime/modelId，整组保存沿用 §3.9.2）；执行状态只读（`GET /consolidation/status`）。UI 契约 `specs/ui/overall/03-config-center.md §2.2`；组件 spec `specs/ui/components/app-dev-config-page/section-consolidation-config.md`。

**行为**：
1. **配置三字段**：enabled（开关）/ dailyTime（每天 HH:mm）/ modelId（模型选择），走 group 独立保存（PUT `/config/app?group=consolidation`）；配置改动**重启生效**（boot-time-only 注册，不热重载）。
2. **「立即整理」按钮**：点击 → POST `/consolidation/run`（202 触发 / 409 已在跑）→ 按钮立即禁用 + 文案「整理中...」；完成/失败经 SSE `consolidation_task_update` 事件恢复可点 + 更新上次整理时间/摘要。
3. **running 状态正确反映 [v0.0.205.t2_cons modified]**：`GET /consolidation/status` 响应含 `status: 'running'|'idle'|'failed'` + `startedAt`；面板初始加载（onInit）据此初始化按钮态（不再写死「可点」）——**整理进行中切走 tab 再切回，按钮仍禁用显「整理中...」**（修切走切回按钮可点 UX bug）。
4. **超时自愈**：任务 hang 超 1h，下次触发（cron 到点或手动点击）服务端自动接管旧锁正常开跑，按钮随事件恢复可点——用户无需干预。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.9.11.1 | 应用设置 → 整理 tab → 点「立即整理」 | 按钮立即禁用 + 文案「整理中...」 |
| UC-3.9.11.2 | 整理进行中 → 切到其他 tab → 切回整理 tab | 按钮仍显示「整理中...」禁用态（onInit 读到 running 状态） |
| UC-3.9.11.3 | 整理完成 → 看按钮 + 状态区 | 按钮恢复可点 + 显示上次整理时间/摘要 |

---

## 版本

```yaml
version: 1.4
intro_version: v0.0.5
note: |
  v0.0.5 配置中心重构。继承 03-llm-chat-features.md §3.7（设置 UI，v0.0.5 取代）
  + §3.8（EP.group + inventory，v0.0.5 在 §3.9.4 扩展为 ext type 分化渲染）。
  三栏化 / 两 tab / ext type 分化 / schema 弹层 / plugin 开关独立（修 bug）。
  v0.0.7 [modified] §3.9.7 新增：providers group 重做三级流（list → detail → model 弹层）
  + 唯一保存 + 前端 diff-save + ModelInstance += label/enabled。数据归属与端点不变。
  v0.0.11 [modified] §3.9.8 新增：observability group（list-of-objects，多 backend 实例列表）
  + list/detail 两视图 + name/type 竖排 + enabled 即时 toggle + secretKey 脱敏 + 不热更新。
  概念边界：UI 只管 CRUD/启停，manager（fan-out/容错）归 tech。
  v0.0.26 [modified] §3.9.9 新增：扩展点 tab 顶层 scope 切换器（ext-impl 配置层正交维度
  scope，agent loop 风格，与 EP.group 功能分区正交）+ per-EP 继承激活模型
  （default 全 EP 永远激活基线，其他 scope per-EP 激活初始值复制 default snapshot 后独立，
  未激活 EP 运行时回退取 default）+ 灰显态 + 激活/取消激活按钮（固定空间不位移）+
  scope 一等实体 CRUD（default 不可删）。权威 tech spec：specs/tech/config/[P0]ext_impl_scope.md。
  v0.0.30 [modified] §3.9.2 dev 配置页 group 集合补 logs group（4 boolean 调试日志开关，
  控制 LogWriter 追加写 <DATA_DIR>/logs/<type>.log；普通 KV group 走既有 key-card boolean
  toggle，不经 observability 特化路由）。dev 调试 feature（非用户产品功能），无新 HTTP 端点
  （复用既有 /config/dev kv-config-handlers 通用 GET/PUT 路径）；hook 契约归 tech
  specs/tech/dev-logs/[P0]overall.md。
  v0.0.47 [modified] §3.9.10 新增：设置入口三合一——app+dev+插件 三页合为单一「应用设置」入口
  （合并页结构：app config tabs + 「展开系统配置」分割线 + dev config tabs + 插件 tab）；
  SKILLS + 连接器 恢复为 nav 底部独立入口（自上而下 SKILLS / 连接器 / 应用设置）；移除 nav
  齿轮子菜单（v0.0.33.1 引入的 5 项折叠）。配置数据结构零修改，各 tab 内容沿用既有 §3.9.2-§3.9.9
  行为；路由收敛（'settings-dev' / 'settings-plugin' view id 废弃，合并入 'settings-app'）。
  详见 version_logs/v0.0.47-ui_opt/change_log.md。
  v0.0.53 [modified] §3.9.7 修订：protocol 归属迁移（model→provider，锁 1:1，单一事实源）+
  provider 二级页加 protocol 下拉（component-provider-fields testid provider-field-protocol，
  选项来自已注册 llm_protocol ext impl × {id,label}）+ 「实际请求地址」mono 展示区（baseUrl +
  protocol.path 实时拼接）+ model 弹层移除 protocolId 字段 + dev/test 现有 4 provider 自动
  迁移（补 protocolId=anthropic_messages，models[] 移除 protocolId）。API 契约：ProviderInstance
  += protocolId（必填），ModelInstance -= protocolId；POST /provider 必带 protocolId，
  POST /provider/:id/model 不再接受 protocolId。后端 LlmClient url 拼接 path 来源从 modelConfig
  切换到 providerConfig，llm-client-factory 按 providerConfig.protocolId 动态取 impl（替代硬编码）。
  数据归属与端点路径不变。详见 version_logs/v0.0.53.protocol_opt/change_log.md。
  v0.0.59 [modified] §3.9.2 app 配置页特有 group 补 locale group（语言选择器卡片，
  primitive-key-choice-cards 两选项「中文」/「English」，切即生效 + PUT 持久化；
  选项 label 自指——「中文」/「English」恒显本身，不随 locale 切换）。i18n 基础设施
  首版（Batch 1）只搭框架 + 1 个后端范式样板（displayReason），页面级迁移走 Batch 2。
  技术权威 specs/tech/i18n/；i18n 全景见 specs/prd/version_logs/v0.0.59.i18n.md（不另起
  prd/overall/09-i18n.md——Batch 1 阶段全貌未稳，version_log 即权威，避免两处同步）。
  v0.0.62 [modified] i18n 迁移 Batch 2：把 9 ns（chat/studio/providers/plugin-config/
  app-dev-config/skill/connector/framework/common）locale bundle 填实 + 组件硬编码文案
  替换为 t() + 配置体系预设（session 默认占位「新会话」/stopReason 等 type code）+ HTTP
  错误体（保留 code 契约 + localized message）+ 内置 plugin.json label/desc（前端按
  plugin id 映射，manifest 不改）。不改 v0.0.59 任何机制（纯机械迁移）。system skill
  SKILL.md 不做（LLM 协议契约）。详见 specs/prd/version_logs/v0.0.62.i18n_migration.md。
  v0.0.72 [modified] §3.9.2 app 配置页特有 group 补 web_search group（自渲染 SectionWebSearchConfig，
  type choice-cards + 动态 credentials + saveMode='item'，凭证从 ext impl configSchema 迁出）；
  §3.9.10 应用设置合并页 sidebar app config 常驻组追加 web_search（位于 providers 之后）。
  详见 specs/prd/version_logs/v0.0.72.md §2.3 + §3.9 + specs/ui/components/app-dev-config-page/
  section-web-search-config/_overview.md。
  v0.0.205.t2_cons [modified] §3.9.11 新增：整理 tab（consolidation group 配置三字段 + 「立即整理」
  手动触发 + 上次整理时间/摘要只读区）；「立即整理」按钮 running 状态正确反映（onInit 读
  GET /consolidation/status 的 status/startedAt 字段，修切走切回按钮可点 UX bug）+ 超时自愈
  （任务 hang 超 1h 服务端自动接管，用户无需干预）。
```

## 版本（元信息）

```yaml
version: 1.8
intro_version: v0.0.5
# v0.0.205.t2_cons modified: §3.9.11 新增整理 tab（consolidation 配置 + 立即整理 running 状态反映 + 超时自愈）
# v0.0.72 modified: app config 增 web_search 自渲染 group（凭证迁 app_config + type choice-cards + saveMode='item'）+ §3.9.10 sidebar 追加 web_search 项
# v0.0.71 modified: inventory 嵌套 groups[].points[].impls[]（D3）+ groups.json 唯一源（D1）+ 齿轮恢复 readOnly modal（D4）+ configSchema 单一源（D7）+ bug-A config JOIN
```
