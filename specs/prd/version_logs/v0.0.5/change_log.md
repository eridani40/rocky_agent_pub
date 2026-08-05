# PRD Change Log — v0.0.5

> 版本：v0.0.5 · 日期：2026-06-20
> 增量记录 v0.0.5 相对 v0.0.4 引入的产品需求变更。全量配置中心产品定义见 `specs/prd/overall/04-config-center-ui.md`。
> v0.0.5 是 **配置中心重构**：app/dev config 三栏化（group 列表 + 配置区，每 key 独立卡片，group 独立保存）；plugin config 加 2 tab（插件 / 扩展点）；扩展点按 type（exclusive/list/ordered）分化渲染；impl schema config 弹层；修复 plugin 开关联动 bug。前端组件式架构已就绪（`specs/ui/components/` 22 组件 spec）。

## 摘要

v0.0.5 针对 v0.0.4 配置 UI 6 项重构（对齐 `states/v0.0.5/task.json` keyDecisions）：

1. **app/dev config 三栏化**：单栏纵向堆叠 → **三栏**（功能导航 56px + group 列表 + 配置区域）。app/dev 两页结构一致，共用 `section-config-layout` + `common/section-group-list` + `component-key-card` + `component-group-save-bar`。
2. **key 卡片化**：配置区域每个 key 一张独立卡片（key 名 + 说明 + 控件），控件类型由 key schema 决定（primitive-key-input/select/boolean）。
3. **group 独立保存**：每个 group 一个「保存」按钮，提交该 group 全部 key。多 group 改动互不串扰。脏状态显「●」。
4. **plugin config 2 tab**：顶部 `插件` / `扩展点` 两 tab。插件 tab = 纯 plugin 列表（名称+描述+独立开关）；扩展点 tab = group 列表 + 扩展点/impl 管理。
5. **扩展点按 type 分化**（v0.0.5 核心）：exclusive=radio 互斥 / list=checkbox 独立 / ordered=拖拽排序+独立开关（排序与开关互不干扰）。
6. **impl schema config 弹层**：有 schemaConfig 的 impl 末尾「配置」齿轮 → 弹层按 schema.type 渲染控件（string/number/boolean/enum/object），独立保存/取消。

外加 **bug 修复**：

7. **plugin 开关联动 bug**（v0.0.4 现象：开 A 关 B 联动）：每个 plugin 开关独立 state，严禁共享。

## 设计原则（v0.0.5 引入，写入 overall）

- **三栏 config（app/dev 共享）**：app/dev config 页统一三栏（功能导航 + group 列表 + 配置区域），共用组件。group 列表来自 `common/section-group-list`（跨页面复用，app-dev config + plugin 扩展点 tab 都用）。
- **group = 保存单元**：保存粒度从「整页/单 key」收敛到「group」——用户改一个 group 的 key，只提交该 group。语义清晰、副作用小。
- **ext type 分化**（v0.0.5 核心）：扩展点声明 `type: exclusive | list | ordered`，UI 按 type 用不同选择控件（radio/checkbox/拖拽+开关）。语义即交互，统一 toggle 不再适用。
- **ordered 的 order 与 enabled 正交**：ordered 扩展点的拖拽排序（order 字段）与 enabled 开关是两个独立维度，互不干扰。拖动不改 enabled，切 enabled 不改 order。
- **schema 驱动弹层**：impl schemaConfig 是控件渲染的契约源（key→type→控件），弹层控件由 schema.type 决定，非硬编码。
- **plugin 开关独立**（修 bug）：每个 plugin 的 enabled 开关 state 独立，严禁共享 slice。
- **继承 v0.0.4 §3.8**：EP.group 必填 + inventory group-centric 不变，扩展点 tab 的 group 列表来自 inventory（按 EP.group 聚合）。

## 文档修订（overall 就地更新）

| 文件 | 修订内容 | 标注 |
|------|---------|------|
| **`04-config-center-ui.md`（新增）** | §3.9 配置中心 UI 全量产品定义（§3.9.1 原则 / §3.9.2 三栏 group 保存 / §3.9.3 plugin 开关独立 / §3.9.4 ext type 分化 / §3.9.5 schema 弹层 / §3.9.6 6 条关键用户路径） | `[v0.0.5]` |
| `03-llm-chat-features.md` 头注 + §3.7/§3.8 | 标注 §3.7（设置 UI）+ §3.8（EP.group，扩展为 ext type 分化）已被 `04-config-center-ui.md` §3.9 取代；下文保留作历史快照 | `[v0.0.5 deprecated → 04]` |
| `03-llm-chat.md` §2.2 | 布局改「chat 2 栏 / 配置页 3 栏」；plugin config 页 2 tab 标注 | `[v0.0.5 modified]` |

## 修订点详述

### 修订 1：app/dev config 三栏化 + key 卡片化 + group 独立保存

- **v0.0.4 现状**：app/dev config 页单栏纵向堆叠 group → key（每 key 一行）。
- **v0.0.5**：**三栏**（功能导航 56px + group 列表 + 配置区域）。
  - **group 列表（common/section-group-list）**：一级选择，列出所有 group（app: appearance/providers；dev: llm_request）。选中左竖条 + 浅底。
  - **配置区域（section-config-layout）**：选中 group 内容，**每 key 一张 component-key-card**（key 名 + 说明 + 控件）。
  - **每 group 保存条（component-group-save-bar）**：固定配置区域底部，「保存该 group」按钮，有未保存改动 → 高亮 + 「●」。
- **保存语义**：点「保存该 group」→ 提交**仅该 group 全部 key**（SET /config/app|dev 带 group 参数）。其他 group 改动不提交。
- **组件契约**：`specs/ui/components/app-dev-config-page/`（page-app-config / page-dev-config / section-config-layout / component-key-card / component-group-save-bar）+ `common/`（section-group-list / component-group-list-item）。

### 修订 2：plugin config 2 tab + 插件 tab 开关独立（修 bug）

- **v0.0.4 现状（bug）**：plugin config 页按 group 平铺 ext impl，只有 enabled toggle；两个 plugin 开关联动（开 A 关 B）。
- **v0.0.5**：顶部 2 tab：
  - **插件 tab（section-plugin-list）**：纯 plugin 列表，每行 component-plugin-item（名称 + 描述 + 开关）。**每个 plugin 开关独立 state**，互不联动（修 bug）。
  - **扩展点 tab**：见修订 3。
- **bug 修复验证路径**：切 plugin A 开关 → plugin B 开关**不变**（UC-3.9.3.2/3.9.3.3）。
- **组件契约**：`specs/ui/components/plugin-config-page/section-plugin-list.md` + `component-plugin-item.md`。

### 修订 3：扩展点 tab · ext type 分化渲染

- **v0.0.4 现状**：扩展点 impl 统一一个 toggle，无 type 区分。
- **v0.0.5**：扩展点 tab **两栏**（左 group 列表，沿用 §3.8 group-centric；右扩展点区 section-ext-point-area）。每个扩展点带 `type` 标签，按 type 渲染：
  - **exclusive（component-ext-impl-radio）**：radio 单选互斥，选其一自动 disable 其余。
  - **list（component-ext-impl-checkbox）**：checkbox 独立勾选。
  - **ordered（component-ext-impl-ordered）**：拖拽手柄（primitive-drag-handle）排序 + 独立 enabled 开关，**order 与 enabled 正交**。
- **组件契约**：`specs/ui/components/plugin-config-page/section-ext-point-area.md` + `component-ext-impl-{radio,checkbox,ordered}.md`。

### 修订 4：impl schema config 弹层

- **v0.0.4 现状**：无 impl 配置入口。
- **v0.0.5**：有 schemaConfig 的 impl 末尾「配置」齿轮 → 弹层（component-schema-config-modal）。弹层按 schema.type 渲染控件（string/number/boolean/enum/object），独立保存/取消，不动 enabled/order。
- **组件契约**：`specs/ui/components/plugin-config-page/component-schema-config-modal.md`。

## 关键用户路径（6 条 = 测试最低覆盖）

| 路径 | 描述 | 关键 UC | 断言落点 |
|------|------|---------|---------|
| P1 | app/dev config 三栏 + group 独立保存 | UC-3.9.2.2/3/4 | 保存只影响被保存 group，不串扰 |
| P2 | plugin 插件 tab 开关独立（bug 回归） | UC-3.9.3.2/3 | plugin A 变化时 B 不变 |
| P3 | 扩展点 exclusive（radio 互斥） | UC-3.9.4.2 | 同扩展点仅一个 enabled，其余变灰 |
| P4 | 扩展点 list（checkbox 独立） | UC-3.9.4.3 | 勾选互不影响，可多选 |
| P5 | 扩展点 ordered（拖拽 + 开关互不干扰） | UC-3.9.4.4/5 | order 变不改 enabled；enabled 变不改 order |
| P6 | impl schema config 弹层 | UC-3.9.5.2/3/4 | 控件由 schema 驱动；保存只落 configValues |

> 每条路径至少 1 个 API + 1 个 E2E case（test-plan.md 阶段 2.5 落地）。

## 不在 v0.0.5 范围（OUT OF SCOPE）

- chat 主界面（v0.0.3 简化形态）—— 本次不动。
- config 三域 service / overlay 模型 / CrudStore 引擎 —— v0.0.2/v0.0.3 已落地，不变。
- provider/model 实例 CRUD 数据归属 / backend handlers —— v0.0.4 已挪 app 设置页 providers 区，本次仅 UI 三栏化外壳，CRUD 行为不变。
- 新增 plugin / ext point / impl（registry 声明）—— 本次只改 UI 渲染层，registry 代码树枝不变。
