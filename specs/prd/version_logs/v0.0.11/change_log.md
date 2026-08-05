# v0.0.11 PRD 变更日志

## 概述

本版本两件事：
1. **可观测性配置化**：将 observability（链路追踪/监控）从写死/读 dev.env 改为 **dev config 页内可配置的列表**（多 backend 实例），支持新增/编辑/删除/启停；agent loop 经 observability manager 对 `enabled` 项异步调用、容错、不影响主流程。当前 vendor 仅 langfuse，按 langfuse 概念做协议定义，预留扩展。
2. **Rocky 品牌**：app 图标 + 对话机器人头像 + 名标统一为 Rocky（hail mary project）。

## 功能需求

### 3.X.1 可观测性配置（dev config · observability group）[v0.0.11]

**描述**：observability 作为 dev config 页的一个特殊 group（list-of-objects，非普通 key-value），用户可管理多个后端实例配置。
**优先级**：P0
**用户故事**：作为开发者，我希望在 dev config 页可视化管理 observability 后端实例（新增/编辑/删除/启停），以便不再写死配置或读 dev.env，并能按需启用多个实例。

#### 用户行为链路 / 关键路径（MANDATORY，= 测试最低覆盖）

| ID | 路径 |
|----|------|
| UC-OBS-1 | 打开 dev config → 左栏选 `observability` group → 右侧见可观测性配置列表（标题 + 现有项 + 添加卡） |
| UC-OBS-2 | 列表 → 点「添加配置」→ 进详情（新建态）→ 填 name/baseUrl/publicKey/secretKey → 保存 → 返回列表见新项 |
| UC-OBS-3 | 列表 → 点某项 → 进详情（编辑态，name/type 竖排、type 只读 langfuse）→ 改 baseUrl → dirty 指示出现 → 保存 → 已保存 |
| UC-OBS-4 | 列表 → 点某项 toggle → 即时启停（不进详情、不弹确认、不计 dirty） |
| UC-OBS-5 | 列表 → 点某项删除 → 弹确认 modal → 确认删除 → 列表移除该项 |
| UC-OBS-6 | 详情 → 改字段后点「重置」→ 回到已保存基线（dirty 清除） |
| UC-OBS-7 | 详情 → 头部 toggle 即时启停（不计 dirty，保存按钮不受影响） |
| UC-OBS-8 | （生效路径）启用某 langfuse 配置 → 重启/重载 → agent loop 经 observability manager 对该 enabled 项异步上报，失败不影响主流程 |

#### 界面要素（对齐 ui spec）

- 列表：标题「可观测性配置」+ desc「observability · 链路追踪与监控」；项 = logo(sage activity) + 状态点 + name + 启用/禁用 badge + desc 行(`{type} · {baseUrl} · {desc}`) + toggle + 删除；底部「添加配置」卡。
- 详情：breadcrumb「可观测性 / {name}」；头部 logo+name+type+toggle；基础信息 section（**name + type 竖排各占一行**，type 只读 langfuse；baseUrl）；认证密钥(仅本地) section（publicKey 明文、secretKey 脱敏）；save-bar（dirty 指示 + 重置[!dirty disabled] + 保存[!dirty disabled]）。
- testid 全量见 `specs/ui/components/app-dev-config-page/observability-config/`。

#### 子功能

- 新增 / 编辑 / 删除（modal 二次确认）/ 启停 toggle（即时）/ 保存（dirty+必填校验）/ 重置（!dirty disabled）。
- 概念边界：observability manager（异步/容错/多实例调度）= tech spec 范畴，UI 只管配置 CRUD 与启停；agent loop 接入归 tech。

### 3.X.2 Rocky 品牌 [v0.0.11]

**描述**：app 图标 + 对话机器人头像 + agent 名标统一为 Rocky（hail mary project 资产 icon.png）。user 头像/名标不动。
**优先级**：P1

#### 关键路径

| ID | 路径 |
|----|------|
| UC-ROCKY-1 | 启动 app → 窗口/Dock 图标为 Rocky icon |
| UC-ROCKY-2 | 进入会话 → agent 消息左头像列显示 Rocky icon 图（非渐变白字）+ 头像下名标「Rocky」 |

#### 界面要素

- agent avatar：28×28 rounded-lg，Rocky icon 占满（不留渐变底）。
- agent name：`Rocky`（10px/600 uppercase muted）。
- app 图标：Rocky icon 多尺寸（实现归 tech/electron）。

## 非功能需求

- observability 配置仅本地存储（secretKey 脱敏展示），安全要求同其他 dev config 密钥。
- observability manager 调用必须异步、容错，单实例失败不得阻断 agent loop。

## 与设计稿差异（用户决策，MANDATORY）

- 详情 name+type 由设计稿横排（f-row-inline）改为**竖排各占一行**。
- observability 是**列表（多 backend）**，每项独立 id/启停/删除。
- Rocky 范围限定为 app 图标 + 机器人头像 + 名标（user 不动）。

## 对齐情况

- UI spec：`specs/ui/components/app-dev-config-page/observability-config/` + `specs/ui/components/chat-page/brand-rocky.md`
- tech spec：observability manager / config store / electron 图标资源（待 arch 产出，本 PRD 不发明概念）
