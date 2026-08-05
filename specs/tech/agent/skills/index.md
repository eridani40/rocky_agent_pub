---
type: index
title: Skills 子系统总起
priority: P0
updated: 2026-08-04
---

# Skills 子系统总起

## ① 是什么

skill = agent 的**可复用能力载体**——一个目录 + 一个 `SKILL.md`（markdown + YAML frontmatter），格式兼容 Claude Code / OpenClaw。本子系统管 skill 的**定义、双层存储、resolver 合并、读工具、管理工具、UI 管理、L0 注入**。范围 = UI 管 + 纯读工具 + 管理工具（skill_manage：create/patch/disable/enable/list/read）+ system prompt 注入。

> **实现状态（v0.0.51 已实现；v0.0.55 改名 evolvable + 删 mutableLocked）**：`skill_manage` 工具（`app/server/src/tools/skill-manage.ts`，6 action 全落地，create 自动注入 3 治理字段 `{source, production_method, evolvable}` + per-file 锁串行化 + evolvable 强制）+ governance service（`app/server/src/skills/governance.ts`，PATCH 端点 + 外科式替换 evolvable 行，**v0.0.55 删 mutableLocked lock 检查**）+ L0 catalog 带 `[evolvable=true|false]` 标记（`app/plugins/builtins/rocky_context/prompt/skills.ts`）+ 三角色 TOOL_POLICY bound 各加 `skill_manage`/`memory_manage`（`app/server/src/agent/tool-policy.ts`）。v0.0.55 UT 4278 / AT 7 case PASS（含 governance_evolvable）。

| 核心概念 | 一句话 |
|---|---|
| **SKILL.md** | 标准协议文件（frontmatter `name/description/allowed-tools` + 正文 + references），格式兼容生态 |
| **progressive disclosure** | 三层加载（L0 catalog 常驻 system prompt / L1 全文按需 / L2 references 深度） |
| **四层 scope** | builtin（内建）+ app 级（`<dataDir>/skills/`）+ workspace 级（`<workspace>/.rocky/skills/`）+ **group 级**（`<groupWs>/.rocky/skills/`，groupWs=squad 或 classroom 团队 ws，经 `resolveGroupWsDir` 唯一解析）；合并优先级 **group > workspace > app > builtin**（下游覆盖上游） |
| **SkillResolver** | 无状态扫描器：四层扫 + frontmatter 解析 + 合并去重 + 注入 enabled → SkillCatalog（`groupDir` 可选参数；non-studio session 缺 groupDir 走原三层） |
| **SkillCatalog** | SessionConfig 持有的 catalog（已过滤 enabled），mapper 拼 L0 + skill 工具 lookup 共用 |
| **skill 工具** | 纯读（input name → SKILL.md 全文 + skillDir + scope）；只读 enabled；不做 list（L0 常驻 prompt） |
| **skill_manage 工具** | 管理用（create/patch/disable/enable/list/read）；list 含 disabled；patch/disable/enable 受 evolvable 强制 |
| **治理单维度（v0.0.55 简化）** | `evolvable`（agent 可改性，强制 false 拒绝写）单维度——**删 `mutableLocked`**（UI 一定能改 evolvable，无需 lock）；详见 `skill_definition.md §6` |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| SKILL.md 协议 + progressive disclosure L0/L1/L2 + 治理单维度（`evolvable`，**强制执行**）+ UI 改 evolvable 走独立 HTTP 路径（`skill_definition.md §8`） | system_prompt `skills` mapper EP 契约（→ `../context/`） |
| 双层 scope + 合并语义（workspace 覆盖 app）+ SkillResolver/Installer | dataDir / workspaceDir bootstrap（→ `../../app/` / `../session/`） |
| skill 读工具（纯读 enabled SKILL.md，仿 bash.ts）+ skill_manage 工具（create/patch/disable/enable/list/read）+ UI 管理 API（install/enable/delete/preview） | HTTP 路由分发 / 路径穿越校验（→ `../../api/` + handlers） |
| enabled 状态落 app_config（复用 AppConfigService） | skill 版本管理 / 供应链安全（roadmap） |
| `skill_state` group + fallback enabled=true（缺省视为开）+ evolvable 强制（false 拒绝 patch/disable/enable）+ UI 改 evolvable 无 lock 约束（`§8`，v0.0.55 删 mutableLocked）+ 写操作原子串行化文件锁（`skill_manage_tool.md §7.2`） | tool_guidance mapper（自动介绍工具，→ `../context/`） |

## ③ 与系统的关系

```
   skills KB                         ┌── agent/context        (system_prompt skills mapper 拼 L0)
   (本目录)   ───────────────────────┼── agent/tools          (skill 工具注册进 defaultTools，纯读)
                                     ├── agent/session        (workspaceDir 来源 + SessionConfig.skills)
                                     ├── persistence          (app_config skill_state group + node:fs 直接操作目录)
                                     ├── tools/               (skill 工具读 ctx.config.skills 寻址)
                                     └── http/router          (新增 /skill 路由组)
```

**对外协作点**：
- 实现落 `app/server/src/skills/{resolver,installer,enabled-store,tree,file-io,types}.ts` + `app/server/src/handlers/skill.ts`（HTTP 编排）+ `app/server/src/tools/skill.ts`（Tool 实现）+ `app/plugins/builtins/rocky_context/prompt/skills.ts`（mapper）。`file-io.ts`（单文件读写原语）由 `/skill/:name/file` 与 academy 版本 skill 文件端点共用，见 `skill_architecture.md §2`。
- SessionConfig 加 `skills?: SkillCatalog`（`agent/context-types.ts:102`）；`buildSessionConfigFromDeps` 末尾 resolve 注入（仅 enabled 项）。
- `defaultTools()`（`tools/registry.ts:50`）含 `skillTool`（与 file×5 + bash 一起，7 个 core 工具之一）。

## ④ 核心设计原则（跨文件不变量）

1. **标准 SKILL.md 协议，不造新协议**——格式兼容 Claude Code / OpenClaw 生态，便于复用。→ `skill_definition.md §2`
2. **progressive disclosure 控 token**——L0 catalog 廉价常驻 system prompt；L1 全文 / L2 references 按需加载（skill 规模化演进的前提）。→ `skill_definition.md §3`
3. **[v0.0.205.t2_cons] 四层合并优先级 group > workspace > app > builtin + `.rocky` 收口**——group 层最高（squad 团队 ws `<groupWs>/.rocky/skills/`；studio 经 squadId 派生 groupDir，唯一解析点 `resolveGroupWsDir`）；workspace 覆盖 app（项目/workspace 是 source of truth 可随 git 共享 pin 版本），app 覆盖 builtin。`SkillScope` 全链 `'builtin'|'app'|'workspace'|'group'`（v0.0.164 的 `'squad'` 改名 + 路径 `.rocky_squad/skills/` → `.rocky/skills/`）；resolver 收 `groupDir?: string` 可选参数，缺省走原三层合并向后兼容。**对外 scope 三层映射**（v0.0.205 用户视角）：session=workspace 层 / group=group 层 / global=builtin+app 层（chat 悬浮菜单 skills 入口按此分组，`GET /skill?sessionId=` 支持按会话解析四层）。→ `skill_definition.md §4.1` + `skill_architecture.md §4` + `specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md`
4. **无状态扫描，永远新鲜**——SkillResolver 不缓存，每次全量扫（skill 数量小，新鲜度 > 性能；缓存会引入 install 后 catalog 不刷新一致性 bug）。→ `skill_architecture.md §4.4`
5. **enabled 状态与 skill 资产分离**——skill 目录是只读标准资产；toggle 状态落 app_config `skill_state` group，不写 skill 目录（不污染下载/手写资产）。→ `skill_architecture.md §3.2`
6. **catalog 一次 resolve 多处消费**——SessionConfig.skills 持完整 catalog（enabled 过滤后），skills mapper 拼 L0 + skill 工具 lookup 共用，避免每 turn 重复扫盘。→ `skill_architecture.md §7/§8/§9`
7. **纯读工具（无 list）**——L0 catalog 已常驻 system prompt，agent 已知 skill 列表；对话场景工具 list 冗余。→ `skill_tool.md §1`
8. **skill_manage：evolvable 强制（agent 路径，[v0.0.55] 改名 mutable→evolvable）**——`evolvable=false` 的 skill 拒绝 patch/disable/enable；`evolvable=true` 才允许。evolvable 字段本身不可被 agent 修改（agent 不碰治理元字段）。→ `skill_definition.md §6.1` + `skill_manage_tool.md §4`
9. **skill_manage：不可 delete**——用 disable 替代（设 enabled=false，可恢复），skill 资产永不自动删除。→ `skill_manage_tool.md §3/§8`
10. **skill_manage：list 含 disabled**——agent 需知道全部 skill（含 disabled）以避免创建撞车重复 skill。disabled ≠ 不存在——不进 L0 catalog 但 list 可见。→ `skill_manage_tool.md §5`
11. **[v0.0.55] 单维度治理（删 mutableLocked）**——`evolvable`（agent 可改性）单维度，**删 `mutableLocked` 维度**（原 v0.0.51 双维度之一）。UI 一定能改 evolvable（用户对自己资产有完全控制权）；agent 不碰治理元字段（不会无聊改这个）；用户要禁某 skill 自进化 → UI 直接把 evolvable 设 false（无需 lock）。系统内置 skill UI 也能改（不强行防呆）。UI 改 evolvable 走独立 HTTP 路径（`PATCH /skill/:name/governance`），不走 `skill_manage` 工具。
12. **写操作原子串行化（v0.0.51 v2 新增）**——`skill_manage` 写操作（create/patch/disable/enable）用 per-file 文件锁序列化，保证跨 agent 并发写不撕裂 SKILL.md。并发安全靠锁（per-file），不靠分区（不按 agent 切分 skill 空间）。读操作不持锁。→ `skill_manage_tool.md §7.2`
13. **[v0.0.149] frontmatter 加 `updated` + L0 注入总量配额（三类分组排序截断）**——frontmatter 新增 `updated`（ISO 8601，短形）/`updatedAt`（语义化）字段，`skill_manage` create/patch + UI governance PATCH 刷新为 now；builtin 在源 frontmatter 带固定值；缺 updated（legacy）→ 排序按 epoch 0 组内末，tiebreak name 升序。**无 skill migration**（文件型，缺失仅排末，下次编辑自动盖戳）。L0 注入加配额：三类分组（system→user→agent）+ 组内 updatedAt 倒序 + 跨组取前 N（默认 50，`app_config.session.maxSkillInject`），纯函数 `selectSkillsByQuota`（`prompt/skills.ts`）。**spec↔code 漂移订正**：`SkillEntry.source` enum 实际 `'user'|'agent'`（**无 `'system'`**，builtin 在 resolver 落 source='user' fallback），system 组必须靠 `scope==='builtin'` 派生（不得只读 source）。skill=stable tier，数量变破 prompt cache（预期内）。→ `skill_definition.md §2/§6.2` + `../context/[P0]system_prompt.md §4`
14. **[v0.0.166] skill 市场 = 协议 + exclusive EP + capability negotiation**——市场源经 `skill_market_provider`（**exclusive**，抄 session_store，非 web_search list）扩展点整源替换（skills.sh 首个 impl）；`SkillMarketProvider` 统一 search/getDetail/**fetchSkillFiles** + `capabilities` 自描述；**capability negotiation 三层字段模型**（通用核心 **ref/name 必有 + description 可选** + 可选能力门控结果字段 + 可选能力门控参数）让「支持与不支持都自适应」，换源零改动。**install = provider.fetchSkillFiles 取文件（source-specific）+ installer source-无关核心落盘**（skills.sh 走 `/api/download` 精确取单 skill，**非 codeload zipball / 非 git 二进制**；复用 installer 落 app scope）。凭证归 app_config `skill_market` group（token 可选，全端点匿名可用）。→ `[P1]skill_market.md`
15. **[v0.0.167] 市场安装写来源元数据 + 同源覆盖守卫 + 惰性 hash 可更新态**——市场安装在 SKILL.md frontmatter 落 `market_ref`/`market_source`/`installed_hash` 三字段（安装来源可溯源，UI 据此标「市场/本地」来源徽标 + 判可更新）。**覆盖守卫「仅同源」**：`finalizeStagedSkill` 冲突分支只在 `overwrite && governance.marketRef && readInstalledMarketRef(磁盘 SKILL.md)===governance.marketRef` 时覆盖，否则抛 `conflict`——**守卫读磁盘 frontmatter（不信前端）**，MUST NOT 覆盖本地手写或异源同名 skill。**可更新态惰性判定**（选项 a）：`getDetail` 复用已取文件返回 `hash`（**零新增请求/端点**，skills.sh getDetail 内部已调 fetchSkillFiles），前端仅在详情弹窗比对 `detail.hash !== installedHash`；列表页零额外请求（不预取 hash）。agent 路径（`skill_manage install`）**不开** overwrite（仅 UI 更新走 overwrite）。→ `[P1]skill_market.md §7.1`
16. **[v0.0.247] 存储数量硬上限（补 v0.0.238 注入配额存储侧缺口）**——注入配额只截 prompt 条数、不限磁盘条目；本版在 `executeCreate` 加各对外 scope active skill 数硬限（global50/group30/session20，与注入配额同值同源——复用 `app_config.session` 三 key；独立 `SkillStoreQuotas` type 概念解耦）。**6 不变量**：① 只在 executeCreate 触发（executePatch/enable/disable 不查——disable 自锁）② disabled 不计入（filter `enabled===true`，与 L0 catalog 同口径）③ builtin 不计（resolver 排除 builtin scope）④ evolvable=false 计入但错误文案如实告知无法 disable ⑤ count+check+write 在 dir 级虚拟锁 `<scopeRoot>/.quota.lock` 内原子（防 TOCTOU race；嵌套 entry 外/dir 内无死锁）⑥ 内部 scope（`app|workspace|group`）经 `toExternalScope` 映射对外查 `quotas[extScope]`。溢出 `SkillQuotaExceededError` 硬拒绝 + 引导 disable 腾位。`executeCreate` 末参 `appConfig: AppConfigService|null=null`（null 不查，向后兼容 UT；生产经 `skill-manage.ts` 单 caller 注入）。→ `skill_definition.md §6.4` + `specs/tech/version_logs/v0.0.247/change_plan.md`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| **概念 / 协议** | | | |
| `skill_definition.md` | SKILL.md 协议（frontmatter + 治理字段）+ progressive disclosure L0/L1/L2 + 双层 scope 合并 | P0 | [link]([P0]skill_definition.md) |
| `skill_tool.md` | skill 读工具（纯读 enabled，input name → SKILL.md 全文 + skillDir）+ 不做 list 的理由 | P0 | [link]([P0]skill_tool.md) |
| `skill_manage_tool.md` | skill_manage 工具（create/patch/disable/enable/list/read）+ evolvable 强制 + list 含 disabled | P0 | [link]([P0]skill_manage_tool.md) |
| `skill_market.md` | Skill 市场后端（SkillMarketProvider 协议 + exclusive EP + capability negotiation 三层字段模型 + skill-manage search/install + `/skills/market/*` + skills.sh source impl） | P1 | [link]([P1]skill_market.md) |
| **实现架构** | | | |
| `skill_architecture.md` | 模块划分 + SkillResolver/Installer/enabled-store + 注入点（dataDir/workspaceDir）+ 文件级变更清单 | P0 | [link]([P0]skill_architecture.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
