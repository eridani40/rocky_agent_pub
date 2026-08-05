# PRD Change Log — v0.0.4

> 版本：v0.0.4 · 日期：2026-06-20
> 增量记录 v0.0.4 相对 v0.0.3 引入的产品需求变更。全量产品定义见 `specs/prd/overall/03-llm-chat.md` + `03-llm-chat-features.md`。
> v0.0.4 是 **v0.0.3 UI 修订 + 配置归属完善**：非重写，复用 v0.0.3 config/plugin/llm/server 底层。

## 摘要

v0.0.4 针对 v0.0.3 bugs.md 反馈做 5 项 UI/设计修订：

1. **sidebar**：左窄菜单改为**窄图标栏（~56px）+ hover tooltip**，4 图标（会话/app/插件/dev），会话图标**可点击切 chat view**（v0.0.3 「最上面的会话不可点击」bug 修复）。
2. **provider/model UI 入口挪 app 设置页**：provider/model 实例 CRUD（app_config providers group 数据实体）UI 入口从插件设置页挪到 app 设置页；backend providers handlers/数据结构**不变**。
3. **插件设置页改纯 plugins+ext impls**：行为主体管理，按 **ExtensionPoint.group 分区**（provider 区下 anthropic_compatible + anthropic_messages），展示 enabled（P0 全开可切）；**移除** provider/model 实例 CRUD。
4. **EP.group 必填**：group 是 ExtensionPoint 固有属性，直接定义在 ext point 上（如 llm_provider/llm_protocol 都 group='provider'），非可选。
5. **inventory group-centric**：PluginConfigService.inventory 改按 **EP.group 聚合**（group→ext impl），UI 按 group 分区渲染；enabled 门 plugin.enabled ∧ impl.enabled 两级不变。

## 设计原则（v0.0.4 引入，写入 overall）

- **配置树由代码决定，非数据决定**：树枝（有哪些 plugin/ext impl/group）100% 来自 registry 代码；config 数据是稀疏 delta 叶子。
- **group 是 EP 固有属性**：ExtensionPoint.group 必填 string；与 config 实体 group 字段（app_config/dev_config schema 的 group:string required 分片键）是**同一 group 概念**两处体现，UI 全按 group 分区，无中间映射表。
- **两个抽象实体（app config）**：provider config 和 model config（数据实体，归属 app config providers group）。
- **两个行为主体（插件管理）**：provider 和 protocol（ext impl，归属插件，按 group 聚合展示）。
- **group=展示分区，enabled=行为门，正交**：group 决定 UI 分区，enabled（plugin∧impl 两级）决定运行时是否生效，互不耦合。

## 文档修订（overall 就地更新）

| 文件 | 修订内容 | 标注 |
|------|---------|------|
| `specs/prd/overall/03-llm-chat.md` §2.2 | 布局改 sidebar 图标栏（~56px + hover tooltip，4 图标，会话可点击切 chat） | `[v0.0.4 modified]` |
| `specs/prd/overall/03-llm-chat.md` §4 | 关键用户路径替换为 v0.0.4 六条（sidebar 导航 / app 设置配 provider+model / 插件页看 ext impls / 回归 chat+theme） | `[v0.0.4 modified]` |
| `specs/prd/overall/03-llm-chat.md` §5 | 追加 5.7 设计决策（v0.0.4 UI 修订 + EP.group + group 一致） | `[v0.0.4]` |
| `specs/prd/overall/03-llm-chat-features.md` §3.5 | Provider/Model 管理 UI 入口改 app 设置页（数据归属不变） | `[v0.0.4 modified]` |
| `specs/prd/overall/03-llm-chat-features.md` §3.7 | 设置 UI：app 设置页加 providers 区；插件设置页改纯 plugins+ext impls（按 group 分区） | `[v0.0.4 modified]` |
| `specs/prd/overall/03-llm-chat-features.md` | 新增 §3.8 Extension Point.group 与 Inventory group-centric | `[v0.0.4]` |

## 修订点详述

### 修订 1：sidebar 图标栏（~56px + hover tooltip）

- **v0.0.3 现状（bug）**：左窄菜单 220px 含文字；顶部「会话」区不可点击（占位无行为）。
- **v0.0.4**：左栏收窄为 **~56px 纯图标栏**，4 个图标自上而下：
  1. **会话**（chat）→ 点击切 `currentView=chat`，修复 v0.0.3 不可点击 bug。
  2. **app 设置**（user/gear）→ `currentView=settings-app`。
  3. **插件设置**（puzzle）→ `currentView=settings-plugin`。
  4. **dev 设置**（wrench）→ `currentView=settings-dev`。
- **hover tooltip**：鼠标悬停图标显示文字说明（如「会话」「应用设置」「插件」「开发者」）；tooltip 绝对定位/预留空间，不得导致图标位移（布局稳定性）。
- **激活态**：当前 `currentView` 对应图标有视觉强调（terracotta 边框 / sage 圆点 / 背景色块之一），激活态变化不导致相邻图标位移。

### 修订 2：provider/model UI 入口挪 app 设置页

- **v0.0.3 现状**：provider/model 实例 CRUD 在**插件设置页** providers_and_models group。
- **v0.0.4**：provider/model 实例 CRUD（添加 provider / 添加 model / 删除）UI 入口挪到 **app 设置页** 新增 `providers` 区。
- **不变**：数据实体归属（app_config providers group）、backend `/provider` `/model` handlers、overlay 聚合（LlmClient resolveProviderConfig deepMerge）、chat 选 model 逻辑。
- **理由**：provider/model 是**用户数据**（app config 实体），与插件行为主体（provider/protocol ext impl）正交；UI 归属应与数据归属一致。

### 修订 3：插件设置页改纯 plugins + ext impls

- **v0.0.3 现状**：插件设置页 = providers_and_models（provider/model 实例 CRUD）。
- **v0.0.4**：插件设置页 = **管理插件本身 + ext impls（行为主体）**，按 **ExtensionPoint.group 分区**：
  - **provider 区**（group='provider'）：含 `llm_provider` 点下的 `anthropic_compatible` + `llm_protocol` 点下的 `anthropic_messages`（两者 EP.group 都是 'provider'，UI 同区分列）。
  - 每个插件项展示 plugin 信息（label + enabled）；每个 ext impl 展示 pointId + implId + enabled（P0 全开，可切 setEnabled/setImplEnabled）。
  - **移除**：provider/model 实例 CRUD（已挪 app 设置页）。
- **inventory 树**：按 group 聚合渲染（见修订 5）。

### 修订 4：EP.group 必填

- **ExtensionPoint.group 是必填 string**（每个 ext point 直接定义其 group）。
- v0.0.4 现有 2 个 ext point 均归 group='provider'：`llm_provider`、`llm_protocol`。
- group 是 **EP 固有属性**（声明期确定），非运行期可选字段。
- spec extension_point_interface §需更新（group: string required）。

### 修订 5：inventory group-centric

- **PluginConfigService.inventory 返回结构按 EP.group 聚合**：`{ [group: string]: Array<{ pluginId, pointId, implId, enabled }> }`。
- UI 按 group 分区渲染（provider 区下展示该 group 所有 ext impl，跨 plugin/跨 point 聚合）。
- **enabled 门不变**：plugin.enabled ∧ impl.enabled 两级，group 仅决定展示分区（正交）。

## 关键用户路径（6 条 — 测试最低覆盖，详见 overall §4）

| 路径 | 链路 | 最低 case |
|------|------|----------|
| 路径 1 | sidebar 会话图标点击 → 切 chat view | ET（sidebar 导航 + 激活态） |
| 路径 2 | app 设置页 → 配 provider + model（UI 入口已挪此） | AT（provider/model CRUD）+ ET（app 设置页 providers 区添加） |
| 路径 3 | 插件设置页 → 看 plugins + ext impls（按 group 分区，enabled） | AT（inventory group-centric）+ ET（插件页按 group 分区渲染） |
| 路径 4 | sidebar app/插件/dev 图标点击 → 切对应设置页 | ET（sidebar 4 图标导航） |
| 路径 5 | chat 选 model（model 现在在 app 设置页配）→ 发消息（回归 v0.0.3 流式） | AT（`/chat` SSE）+ ET（chat 流式） |
| 路径 6 | app 设置页 appearance 切 theme（回归 v0.0.3） | AT（set/get theme）+ ET（theme 视觉变化） |

## 对 v0.0.3 的影响（spec 同步范围）

- `specs/ui/overall/02-llm-chat.md` §2（布局改 sidebar 图标栏）/§4（app 设置页加 providers 区）/§5（插件页改 ext impls group 分区）需 coder 同步更新。
- `specs/api/overall/` 无新增端点（providers/model handlers 不变），inventory 返回结构变更需在 plugin config 端点 doc 标注。
- `specs/tech/overall/` extension_point_interface 需补 group 必填约束；PluginConfigService.inventory 返回结构改 group-centric。

## 范围边界（v0.0.4）

### IN SCOPE

1. sidebar 图标栏（~56px + hover tooltip，4 图标，会话可点击）。
2. app 设置页新增 providers 区（provider/model 实例 CRUD 迁入）。
3. 插件设置页改纯 plugins + ext impls（按 EP.group 分区，enabled 展示）。
4. EP.group 必填（类型约束 + spec 更新）。
5. PluginConfigService.inventory 改 group-centric（返回结构 + UI 渲染）。
6. spec 同步：ui §2/§4/§5、prd §2.2/§3.5/§3.7/§3.8、tech extension_point_interface。

### OUT OF SCOPE

- 新 ext point（仍只 llm_provider / llm_protocol）。
- 外部插件 discovery/install/origin（P1）。
- config 聚合逻辑变更（仍 LlmClient resolveProviderConfig deepMerge）。
- backend providers handlers/数据结构变更（数据归属不变，仅前端 UI 入口迁移）。
- chat 流式/protocol 逻辑（v0.0.3 已验证，仅回归）。

## 版本

version: 1.0
