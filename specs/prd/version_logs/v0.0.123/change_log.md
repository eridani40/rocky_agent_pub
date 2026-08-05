# v0.0.123 — web search provider 拆分（zhipu_coding_plan / zhipu_api）

> 引入版本：v0.0.123 · 类型：既有能力拆分 + 一次性配置迁移（无新概念，仅在已有扩展点上多一个 impl + implId 更名）
> 概念权威源（MANDATORY 对齐 — 已读，本 PRD 引用其术语，不发明新概念）：
> - `specs/tech/agent/tools/[P1]web_search_tool.md` — `WebSearchProvider` 协议 + `web_search_provider` list EP + `resolveProvider` 按 `type` 路由（**本版本不改**，复用）
> - `specs/tech/config/[P0]app_config.md` §3.6 — web_search group 数据结构 `{type, credentials: map<implId,{apiKey}>}`（**本版本复用**，仅 implId 变化 + 多一项 + 一次性迁移）
> - `specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md` — type 下拉（`ComponentChannelTypeDropdown`）+ 动态 credentials + testid（**控件形式不变**，implId 变化）
> 需求来源：`reqs/[working] v0.0.123.search/req.md` + `states/v0.0.123/task.json` decisions（用户 2026-07-12 裁决）
> doc-sync 备注：overall（`07-web-tools.md §7.2.1/§7.5` + `04-config-center-ui.md` web_search section）需小幅同步（provider 从 1 变 2 + implId 更名 + 迁移记录）——**本 version_log 为权威**，overall 留待 doc-modifier 阶段统一改。

---

## 1. 背景与目标

### 1.1 现状

web_search 工具当前仅 **1 个** provider（implId=`zhipu`）。它在 dev1 的**真实实现本质是「智谱 coding plan 订阅额度」链路**——走 MCP 端点 `open.bigmodel.cn/api/mcp/web_search_prime/mcp`（web_search_prime，消耗 coding plan 订阅额度），而非 spec §7 里记录的旧 REST 端点。

旧的 REST 实现（走 `open.bigmodel.cn/api/paas/v4/web_search`，按量计费）是另一条独立链路：访问方式不同、计费不同、key 也隔离。它在 v0.0.121（commit `0b64ae54` 的父版本）被 MCP 实现替换删除。

**问题**：现在把「订阅额度链路」和「按量计费链路」混叫成一个 `zhipu` provider，用户无法同时拥有两条链路、无法按需选择用哪条计费方式。

### 1.2 目标

把 web_search 的智谱 provider 从 **1 个拆成 2 个独立 provider**，各自 key 隔离、访问链路隔离，用户在配置页自由选择用哪条：

| implId（用户裁决，不得更改） | 本质 | API 端点 | 计费 |
|---|---|---|---|
| `zhipu_coding_plan` | 现 dev1 MCP 实现改名 | `open.bigmodel.cn/api/mcp/web_search_prime/mcp` | coding plan 订阅额度 |
| `zhipu_api` | 旧 REST 实现从 git 历史恢复 | `open.bigmodel.cn/api/paas/v4/web_search` | 按量计费 |

二者**各只需一个 apiKey**，配置控件形式完全一样（type 下拉从 1 项变 2 项，选中谁就显示谁的 apiKey 输入框）。既有用户的旧 `zhipu` 配置一次性迁移到 `zhipu_coding_plan`（现有 key 实为 coding plan key）。

### 1.3 本版本无新概念

本版本**不引入任何新概念**，只是在已有扩展点/数据结构上做增量：
- 已有的 `web_search_provider` list EP 上，从 1 个 ext impl 变 2 个 ext impl。
- 已有的 `app_config.web_search` group 数据结构 `{type, credentials}` 不变，只是 `type`/`credentials` 里的 implId 从 `zhipu` 变成 `zhipu_coding_plan` / `zhipu_api`。
- 已有的 UI section（type 下拉 + 动态 credentials）控件形式不变，只是候选 impl 从 1 项变 2 项。

---

## 2. 功能需求

### 2.1 两个独立 web_search provider [v0.0.123]

**描述**：`web_search_provider` list EP 承载两个内置 ext impl，各自独立、协议一致、凭证隔离。
**优先级**：P0
**用户故事**：作为使用 web_search 的用户，我希望能选择「订阅额度」或「按量计费」两条智谱链路之一，以便按我的计费方式和额度用搜索。

#### 两个 provider 的契约（复用现有 `WebSearchProvider` 协议，协议本身不改）

| provider | implId | label（UI 展示名，建议见 §5） | isAvailable / search 凭证 | 端点行为 |
|---|---|---|---|---|
| coding plan | `zhipu_coding_plan` | 建议见 §5 | `cfg.apiKey` 非空 | MCP `web_search_prime` |
| REST api | `zhipu_api` | 建议见 §5 | `cfg.apiKey` 非空 | REST `/api/paas/v4/web_search` |

- 两个 impl 都实现现有 `WebSearchProvider` 协议：`id` / `label` / `isAvailable(cfg)` / `search(query, opts, cfg, signal?)`，凭证从运行时入参 `cfg.apiKey` 读（沿用 v0.0.72 契约，**不新增除 apiKey 外的凭证字段**）。
- `isAvailable(cfg) === !!(cfg.apiKey && cfg.apiKey.length > 0)`；`search` 中 `cfg.apiKey` 空 → 抛 Error，tool 层 catch 转 ToolError（**现有语义完全不变**）。
- 两个 impl 的响应都归一到同一 `WebSearchResult` 形状（title/url/snippet 等），Tool 层统一序列化/截断/wrapExternalContent（**现有链路不变**）。

#### 用户行为链路

安装态下（两个 provider 都是内置 ext impl，随插件激活即在 EP 列表中）：
- agent 调 `web_search({query})` → tool `resolveProvider` 读 `app_config.web_search.default` 取 `{type, credentials}` → 按 `type` 在 list EP 精确匹配 impl（`zhipu_coding_plan` 或 `zhipu_api`）→ `cfg = credentials[type] ?? {}` 传 impl → impl 走各自端点 → 归一结果。
- **路由逻辑（`resolveProvider`）本版本零改动**：它已经是「按 `type` 精确匹配 impl.id」，多一个 impl 天然被枚举到，无需改路由代码。

### 2.2 配置页：type 下拉从 1 项变 2 项 [v0.0.123]

**描述**：「应用设置 → 网络搜索」section 的 type 下拉候选从 1 个变 2 个；选中谁显示谁的 apiKey 输入框，各自 key 独立保存。
**优先级**：P0
**用户故事**：作为用户，我希望在配置页下拉里看到两个智谱 provider 选项、分别填各自的 key 且互不覆盖，以便同时保存两条链路的凭证、随时切换。

#### 界面要素（复用现有 UI 契约，控件形式不变）

- **type 下拉**（`ComponentChannelTypeDropdown`，testid `web-search-type-select`）：候选 = `web_search_provider` ext impl 列表，现在有 **2 项** option（`web-search-type-select-opt-zhipu_coding_plan` / `web-search-type-select-opt-zhipu_api`）。option label = 各 impl 的人类可读展示名（§5 建议文案，走 impl.description i18n）。
- **credentials 字段**（按选中 type 动态）：选中 `zhipu_coding_plan` → 渲染 `web-search-cred-zhipu_coding_plan-apiKey`（secret input）；选中 `zhipu_api` → 渲染 `web-search-cred-zhipu_api-apiKey`。字段映射 `credentials.<implId>.apiKey`。
- **各自 key 独立存储**：`credentials` 是 `map<implId,{apiKey}>`，两个 implId 的 apiKey 是 map 里两条独立 entry，**切换 type 不清空另一个的 key**（保存整组 PUT，两条 credentials 都带上）。
- **保存/重置**：`web-search-save` / `web-search-reset`，saveMode='item'，dirty 判定 = 草稿 vs 服务器基线深比较（现有语义不变）。

#### 布局稳定性

type 下拉切换 option 时，下方 credentials 输入区按选中 impl 动态切换。切换过程中 section 容器高度尽量稳定：apiKey 字段始终占一行固定空间（label + secret input），下拉展开/收起、字段切换不得导致 save/reset 按钮或其他 section 元素跳动。

### 2.3 旧配置一次性迁移到 zhipu_coding_plan [v0.0.123]

**描述**：既有用户落盘的旧 `zhipu` web_search 配置，升级后一次性迁移到 `zhipu_coding_plan`，迁移后搜索照常可用、无需用户重填 key。
**优先级**：P0
**用户故事**：作为已配置旧 zhipu 的老用户，我希望升级后无感——旧 key 自动归位到「coding plan」provider、搜索继续能用，以便不因这次拆分丢配置。

#### 迁移规则

旧 record：
```json
{ "type": "zhipu", "credentials": { "zhipu": { "apiKey": "<现有 key>" } } }
```
迁移后：
```json
{ "type": "zhipu_coding_plan", "credentials": { "zhipu_coding_plan": { "apiKey": "<现有 key>" } } }
```

- `type: "zhipu"` → `type: "zhipu_coding_plan"`。
- `credentials.zhipu` 整条 entry（含 apiKey）→ `credentials.zhipu_coding_plan`（key 名改，apiKey 值原样保留——现有 key 实为 coding plan key，用户裁决）。
- **迁移机制约束（沿用 app_config 迁移惯例 + memory `runtime-no-ext-policy-write`）**：一次性、带版本 marker、幂等、非破坏。禁止运行时启动路径做无 marker 的破坏性改写（避免误清用户正经配置）。具体迁移落点（迁移脚本 / 读侧兼容）由架构期在 tech spec 定义，PRD 只约束「迁移方向 + 幂等非破坏」。
- 迁移只处理 `type='zhipu'` 且 `credentials.zhipu` 存在的旧 record；已是新 implId 的 record 不重复迁移（幂等）。
- 无旧 zhipu 配置的用户（record 缺失 / type 已是新值）→ 迁移 no-op，不影响。

### 2.4 未配置时的错误语义不变 [v0.0.123]

**描述**：`type` 未配置 / 选中 type 的 apiKey 未配置时，web_search 工具返回 ToolError 的现有语义**完全不变**。
**优先级**：P0
**用户故事**：作为用户，当我没配 type 或没填 key 时，我希望工具明确报错而不是静默换 provider，以便知道是配置问题。

- `app_config.web_search.default` record 缺失 / `data.type` 缺失 → ToolError「web_search 未配置 provider type」。
- `type` 对应 impl 未激活 → ToolError「web_search type `{type}` 对应 impl 未激活」。
- 选中 impl 的 `cfg.apiKey` 空（`isAvailable(cfg)=false`）→ ToolError「provider `{label}` 不可用（凭证未配置?）」，不静默回退另一个 provider。

#### E2E Use Cases（本章 = §4 关键用户路径的验收锚点，详见 §4）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 老用户旧 zhipu 配置（type=zhipu + credentials.zhipu.apiKey）升级 → 触发一次性迁移 → agent 调 `web_search({query})` | 配置已迁为 `zhipu_coding_plan`（type + credentials key），走 MCP 链路搜索成功返回结构化结果，用户无需重填 key |
| UC-2 | 用户在「应用设置 → 网络搜索」下拉选 `zhipu_api` → 填 apiKey → 保存 → agent 调 `web_search({query})` | 保存成功（credentials.zhipu_api.apiKey 落库），工具走 REST `/api/paas/v4/web_search` 链路返回结果 |
| UC-3 | 用户先选 `zhipu_coding_plan` 填 keyA 保存 → 再切到 `zhipu_api` 填 keyB 保存 → 切回 `zhipu_coding_plan` | 两个 provider 的 apiKey 各自独立保存互不覆盖：切回时 coding plan 的 keyA 仍在（mask 展示），api 的 keyB 也在 |
| UC-4 | type 未配置（或选中 impl 未填 key）→ agent 调 `web_search({query})` | 工具返回 ToolError（「未配置 provider type」/「provider 不可用（凭证未配置?）」），不静默换 provider（现有语义不变） |

---

（关键用户路径见 §4；范围边界见 §6）
