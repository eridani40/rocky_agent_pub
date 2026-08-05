# v0.0.123 — 关键用户路径 + 范围边界 + 设计决策

> 本文与 `change_log.md`（功能需求）同属 v0.0.123 PRD。
> §4 关键用户路径 = 测试最低覆盖要求（每条路径至少一个 API/E2E case）。

---

## 4. 关键用户路径（MANDATORY）

本版本核心是「provider 从 1 变 2 + implId 更名 + 一次性迁移」，关键路径覆盖：迁移、两条链路各自可用、切换互不影响、错误语义不变。

### 路径 1：老用户升级 → 旧配置自动迁移到 zhipu_coding_plan → 搜索照常可用

```
老用户旧 record { type:"zhipu", credentials:{ zhipu:{apiKey} } }
  → 升级触发一次性迁移（带 marker、幂等、非破坏）
  → record 变 { type:"zhipu_coding_plan", credentials:{ zhipu_coding_plan:{apiKey} } }
  → agent 调 web_search({query})
  → resolveProvider 按 type=zhipu_coding_plan 路由到 MCP impl
  → 走 web_search_prime 链路 → 返回结构化结果（title/url/snippet）
```
**断言（用户价值）**：迁移后 type 与 credentials key 均为 `zhipu_coding_plan`，apiKey 值不变；无需用户重填 key；搜索返回非空结构化结果、无 error。

### 路径 2：用户选 zhipu_api 并填 key → web_search 走 REST 链路成功

```
配置页 → type 下拉选 zhipu_api → 填 apiKey → 保存（整组 PUT，credentials.zhipu_api.apiKey 落库）
  → agent 调 web_search({query})
  → resolveProvider 按 type=zhipu_api 路由到 REST impl
  → 走 /api/paas/v4/web_search（按量计费）→ 返回结构化结果
```
**断言（用户价值）**：保存后 `credentials.zhipu_api.apiKey` 落库；工具走 REST 端点返回非空结果。

### 路径 3：两个 provider 间切换 → 各自 key 独立保存互不影响

```
配置页 → 选 zhipu_coding_plan 填 keyA 保存
  → 切 zhipu_api 填 keyB 保存
  → 切回 zhipu_coding_plan
```
**断言（用户价值）**：`credentials` map 同时含 `zhipu_coding_plan.apiKey=keyA` 与 `zhipu_api.apiKey=keyB` 两条独立 entry；切换 type 不清空另一个的 key（切回时 keyA 仍 mask 展示）；两条凭证互不覆盖。

### 路径 4：type 未配置 / key 未配置 → web_search 返回 ToolError（语义不变）

```
（a）type 未配置：record 缺失或 data.type 缺失 → agent 调 web_search
（b）key 未配置：选中 impl 的 cfg.apiKey 空（isAvailable=false）→ agent 调 web_search
```
**断言（用户价值）**：（a）返回「web_search 未配置 provider type」；（b）返回「provider `{label}` 不可用（凭证未配置?）」。均不静默换 provider，与现有语义一致。

### 4.x 用户路径 → 测试类型映射（供 test-plan 参考）

| 路径 | 主验证形态 | 说明 |
|------|-----------|------|
| 路径 1（迁移 + coding plan 搜索） | API（真服务 / record-replay）+ 迁移 UT | 迁移正确性 + MCP 链路结果 |
| 路径 2（api REST 搜索） | E2E（配置页填 key 保存）+ API（REST 链路结果） | 配置落库 + REST 结果 |
| 路径 3（切换互不影响） | E2E（配置页两次填 key + 切换 + 校验 mask） | credentials map 两条独立 entry |
| 路径 4（错误语义） | API（两分支 ToolError） | 现有语义回归，不静默回退 |

---

## 5. UI 展示名建议文案（供用户确认）

implId 是用户裁决（`zhipu_coding_plan` / `zhipu_api`，snake_case，不得更改）；下拉 option 的**人类可读展示名**（走各 impl 的 `description` i18n 文案）由本 PRD 提出建议，供用户拍板。原则：让用户一眼分清「订阅额度」vs「按量计费」两条计费链路。

| implId | 建议展示名（zh-CN） | 建议展示名（en） | 理由 |
|---|---|---|---|
| `zhipu_coding_plan` | 智谱 · Coding Plan（订阅额度） | Zhipu · Coding Plan (subscription) | 强调用 coding plan 订阅额度，与按量计费区分 |
| `zhipu_api` | 智谱 · API（按量计费） | Zhipu · API (pay-as-you-go) | 强调按 API 调用量计费的独立 key 链路 |

- 备选简洁版：`智谱 Coding Plan` / `智谱 API`（若嫌括号说明太长）。
- 展示名仅影响下拉 option 文案与 ToolError 里的 `{label}`，**不影响 implId、不影响任何路由/存储逻辑**。
- 建议同时给两个 provider 各自的 apiKey 输入框 label 保留通用「API Key」（现有 `webSearch.apiKeyLabel`），或按需加副提示（coding plan key vs api key），由 UI 实现细节决定。

---

## 6. 范围边界

### 6.1 IN（本版本做）

- `web_search_provider` list EP 上从 1 个 impl 变 2 个 impl（`zhipu_coding_plan` 现 MCP 实现改名 + `zhipu_api` 旧 REST 实现从 git 历史恢复）。
- 两个 impl 各实现现有 `WebSearchProvider` 协议，凭证各自 `cfg.apiKey`。
- `app_config.web_search` group 数据里的 implId 从 `zhipu` 变 `zhipu_coding_plan` / `zhipu_api`（数据结构不变）。
- 旧 `zhipu` 配置一次性迁移到 `zhipu_coding_plan`（带 marker、幂等、非破坏）。
- 配置页 type 下拉候选从 1 项变 2 项 + 各自 apiKey 输入框 + 各自 key 独立存储。
- spec 以两个实现的真实行为为准更新（现 MCP 实现的真实端点 `.../api/mcp/web_search_prime/mcp` 补进 tech spec；旧 REST 端点归 `zhipu_api`）。

### 6.2 OUT（本版本不做 — 明确「不做什么」）

- **不改 `WebSearchProvider` 协议**：`id`/`label`/`isAvailable(cfg)`/`search(query,opts,cfg,signal?)` 契约保持原样，两个 impl 都实现它。
- **不改 tool `resolveProvider` 路由逻辑**：它已按 `type` 精确匹配 impl.id，多一个 impl 天然被枚举，路由代码零改动。
- **不新增除 apiKey 外的凭证字段**：两个 provider 各自只需一个 apiKey，credentials 结构 `{apiKey?}` 不变（不加 baseUrl/model 等字段）。
- **不改 web_search 的截断 / wrapExternalContent / 序列化链路**：结果归一形状 + Tool 层处理不变。
- **不引入第三个非智谱 provider**（Tavily/Google/Bing）：仍是 roadmap，本版本只拆智谱两条链路。
- **不改配置页整体框架**（应用设置合并页 sidebar 注入、saveMode='item'、整组 PUT 语义）：只在既有 section 内多一个候选 impl。
- **不做多 provider 并发融合**：一次搜索仍单点路由到一个 provider（现有 list-但-单点-路由 决策不变）。

---

## 7. 设计决策（用户裁决 + 沿用现有）

| 决策 | 结论 | 依据 |
|---|---|---|
| **D1 implId 命名** | `zhipu_coding_plan` / `zhipu_api`（snake_case 对称，不得更改） | 用户 2026-07-12 裁决 |
| **D2 迁移方向** | 旧 `zhipu` → `zhipu_coding_plan`（type + credentials key 同改，apiKey 值原样保留，因现有 key 实为 coding plan key） | 用户裁决 |
| **D3 迁移机制** | 一次性、带版本 marker、幂等、非破坏（禁运行时启动路径无 marker 破坏性改写） | memory `runtime-no-ext-policy-write` + app_config 迁移惯例（v0.0.89 / v0.0.114） |
| **D4 spec 更新以真实行为为准** | 现 MCP 实现的真实端点 `.../api/mcp/web_search_prime/mcp` 补进 tech spec；旧 REST 端点归 `zhipu_api` | 用户 2026-07-12 指令 |
| **D5 协议 / 路由 / credentials 结构不变** | 复用现有概念，不发明新概念（见 §6.2） | 概念权威源对齐 |
| **D6 UI 控件形式不变** | type 下拉（`ComponentChannelTypeDropdown`）+ 动态 credentials 复用现有 section，仅候选从 1 变 2 | `section-web-search-config` UI 契约 |

---

## 8. 概念对齐自查（PRD ↔ ui/tech spec）

| PRD 引用 | 权威源 | 是否一致 |
|---|---|---|
| `WebSearchProvider` 协议（id/label/isAvailable/search + cfg 入参） | `[P1]web_search_tool.md §2` | ✅ 一致，不改协议 |
| `web_search_provider` list EP + 按 type 单点路由 | `[P1]web_search_tool.md §3/§4` | ✅ 一致，多 impl 天然枚举 |
| `resolveProvider`（读 app_config → 按 type 匹配 impl.id → cfg=credentials[type]） | `[P1]web_search_tool.md §4` | ✅ 一致，路由逻辑零改动 |
| `app_config.web_search` `{type, credentials: map<implId,{apiKey}>}` | `[P0]app_config.md §3.6` | ✅ 一致，仅 implId 值变化 + 一次性迁移 |
| 缺失语义（未配置 type/key → ToolError，不静默回退） | `[P1]web_search_tool.md §4` + `app_config.md §3.6` | ✅ 一致，语义不变 |
| type 下拉 `ComponentChannelTypeDropdown` + testid（`web-search-type-select` / `-opt-{implId}` / `web-search-cred-{implId}-apiKey`） | `section-web-search-config/_overview.md §3/§4/§6` | ✅ 一致，implId 占位变化（2 个 impl） |
| saveMode='item' + 整组 PUT + dirty 深比较 | `section-web-search-config/_overview.md §5` | ✅ 一致 |

**结论**：本 PRD 全部引用与 ui/tech spec 对齐，无发明新概念、无与 spec 矛盾。唯一「需 spec 层动作」的是 tech spec §7 把现 MCP 实现真实端点补上 + 恢复 `zhipu_api` REST impl 记录（架构期做，属 D4 「spec 以真实行为为准更新」，非 PRD 发明概念）。
