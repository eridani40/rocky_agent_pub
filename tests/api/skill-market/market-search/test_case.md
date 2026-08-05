# AT case: market-search

> 模块 `skill-market` / case `market-search`
> 路径：`tests/api/skill-market/market-search/`
> 新增于 v0.0.167（用户 2026-07-17 指示：「skill search 的 api 需要加 at」+「加 1 个 at 就行」）；v0.0.190 更新为真实调 API（不再依赖 stub / recordings / record→replay 双关）

## 覆盖目标

验证 **skill 市场 search API 主路径**的 HTTP 契约：capability negotiation 生效 + `GET /skills/market/search` 返回结构正确。真实调 skills.sh API（不录制不回放）。

## 断言依据（specs/api 契约权威）

本版本 skill 市场端点契约落在 **`specs/tech/agent/skills/[P1]skill_market.md`**（v0.0.166 交付；`specs/api/overall/` 下暂无独立 market 文档 — 见下「偏离」）：

- §9 `/skills/market/*` HTTP 端点表：
  - `GET /skills/market/capabilities` → `{ id, label, capabilities }`（无 active provider → 503）
  - `GET /skills/market/search?q=&owner=&limit=&cursor=` → 200 `SkillMarketSearchResult`（缺 `q` → 400）
- §2 类型契约：
  - `SkillMarketSearchResult = { provider, query, count, tookMs, items[], nextCursor? }`
  - `SkillMarketItem`：通用核心必有 `ref` / `name`；`description?` 为核心可选（search 阶段 skills.sh **不返回**）；`stats?: { installs?, stars? }`
- §3 capability negotiation：上层先问 capabilities 再渲染；provider 只填自己声明的能力维度
- §8 skills.sh impl：`capabilities = { stats: ['installs'] }`（单一统计维度，**无 stars/categories/sorts**）；`search` 出站 `GET https://skills.sh/api/search?q={query}`，经 `proxyFetch`（web-fetch 代理层）

## step 设计

| step | 请求 | check（断言点） |
|------|------|-----------------|
| 1 | `GET /skills/market/capabilities` | `.id` / `.label` / `.capabilities` 存在；`.capabilities.stats[0] == "installs"`（skills.sh 单元素数组契约） |
| 2 | `GET /skills/market/search?q=git` | `.provider` 存在；`.query == "git"`（回显）；`.count >= 1`；`.items` 存在；`.items[0].ref` / `.items[0].name` 存在；`.items[] any .stats.installs >= 0`（命中项含 installs） |

### DSL 关键点 / 陷阱规避
- **数组谓词子谓词不支持 `exists`**：断「每项含 ref/name」改用 index 断言 `.items[0].ref exists` / `.items[0].name exists`（DSL 数组谓词 `any/all` 的子谓词只支持路径比较，不支持 `exists`/`absent` 一元）。
- **`stats.installs` 用数组谓词 `any`**：`.items[] any .stats.installs >= 0` —— 子路径 `.stats.installs` 是普通路径比较（合法），验证命中项带 installs 统计维度。
- **capabilities.stats 用 index**：skills.sh 契约 `stats: ['installs']` 恰单元素 → `.capabilities.stats[0] == "installs"` 最稳（避开元素级 `.` 谓词的写法不确定性）。
- **不断言 description**：search 阶段 skills.sh 不返回 `description`（核心可选字段），按指示「不断言不存在的字段」，只验证核心字段存在。
- **check 右侧不插值**：本 case 无需动态实体唯一化，未用 `save`；所有 check 右侧均为字面量（`"git"` / `"installs"`），无 `{var}` 插值陷阱。

## install 取舍（本 case 不含 install round-trip — 设计裁决）

用户「install 加不加都行」+「优先保证 search case 稳定」。经权衡 **不将 install round-trip 放进本 case**：

- 若把 `POST /skills/market/install`（202 → 同 ref 再装 409）放进本 case，其任一步骤失败会**连带整个 search case 一起 fail**（同 case 单步 fail = 整 case fail），反而危及用户核心诉求。
- install 引入 2 个 flaky 向量：① 依赖 `items[0].ref` 真实可下载；② 真实文件落盘 DATA_DIR，install 后须靠 teardown `DELETE /skill/:name` 精确清理才能重入，链路脆。
- install 的后端契约已由 **UT 覆盖**（test-plan §2：U1 安装元数据 frontmatter / U2 覆盖守卫仅同源 / U5 handler overwrite 解析），无需 AT 重复。

若后续确需 AT 覆盖 install，建议**另立独立 case**（与 search 解耦），而非塞进本 case。

## 真实调注意（交 api-test-executor）

- **真实调 skills.sh**：step2 真打 `https://skills.sh/api/search?q=git`，需网络可达 + skills.sh 在线（对 "git" 返 ≥1 结果）；429/503 等限流自动 case 标 skipped（不重试不阻塞）。
- **环境前置**：`skills_sh` builtin plugin 须在 test env 生效（否则 capabilities 返 503，step1 fail —— 属环境/产品问题，非 case 缺陷）。

## 与 specs/api 的偏离（doc-sync 待办）

- **`specs/api/overall/` 下无独立 skill 市场端点文档**：v0.0.166 把 `/skills/market/*` 契约写在 tech spec `[P1]skill_market.md` §9，未落 `specs/api/overall/06-skill.md`（该文档只覆盖 `/skill/*` 单数端点）。本 case 断言依据 tech spec §9/§2/§3/§8。**建议 doc-modifier 阶段把 market HTTP 端点补进 `specs/api/overall/`（如 06-skill.md 或新增 06b）**，使 API 契约有 overall 层权威文档。汇报给 orchestrator 记 doc-sync 待办。
