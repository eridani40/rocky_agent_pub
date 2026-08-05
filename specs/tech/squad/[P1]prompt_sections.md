---
type: spec
title: Squad prompt section 契约
priority: P1
status: active
updated: 2026-08-03
since: v0.0.33.2
---

# Squad prompt section 契约（system_prompt mapper vs system_reminder provider 分工）

> 定位：定义 squad/studio 各 prompt section 的**归属（system_prompt vs system_reminder）+ 字段契约 + 分流规则（Option A）+ tier + 数据源**，以及 system prompt 生命周期 + member.systemPrompt 移除迁移。
> 参考：`reqs/v0.0.33.3/req6`（system prompt 组装）/ `req7`（reminder 注入）/ `req8`（统一机制，权威裁决）/ `req11`（provider 详细）/ `req13` C1/C2/C3/C6（review 修正）；`../agent/context/[P0]system_prompt.md`（mapper/reducer EP + PromptFragment + tier）；`../agent/context/[P0]system_reminder.md`（system_reminder EP）；`[P1]squad_reminder_providers.md`（squad_workspace / squad_team_status provider 详细）；`[P1]data_model.md §1.1/§1.2`（Squad/Member entity）；`[P1]session_config_studio.md`（studioContext + sessionType 字段）。
> 命名：role / session.type 一律 **mate**（非 member）；Member entity 字段名（member.tools/skills/model）保留——那是 entity 字段非 role。

---

## 1. 概述：固定 vs 动态（req8 §3 裁决）

- **system prompt** = **固定规范**（角色人设 / rules / 协作规则 / 工具说明 / skills）→ `system_prompt_mapper` EP
- **system reminder** = **动态补充**（workspace 路径 / team-status / reachable）→ `system_reminder` EP（roster 例外，见下）

二者合并即 agent 看到的完整上下文。

**贡献点总表**（studio scope）：

| 贡献点 | EP | 文件 | section id | 分流 | tier |
|---|---|---|---|---|---|
| **squad_role** mapper | `system_prompt_mapper` | `prompt/squad_role.ts` | `squad_role` | leader/mate/squad 各不同 | stable |
| team_roster mapper | `system_prompt_mapper` | `prompt/team_roster.ts` | `team_roster` | 非 subagent | stable |
| parent_task mapper | `system_prompt_mapper` | `prompt/parent_task.ts` | `parent_task` | subagent only | stable |
| squad_workspace provider（v0.0.111） | `system_reminder` | `reminder/squad_workspace.ts` | `squad_workspace` | leader + mate | info |
| squad_team_status provider（[v0.0.116]） | `system_reminder` | `reminder/squad_team_status.ts` | `squad:team-status` | leader only | info |
| reachable_agents provider | `system_reminder` | `prompt/reachable_agents.ts` | `reachable_agents` | 非 standalone | info |

**roster 留 stable system_prompt mapper**（req13 C6——随 hire/bench 变、频率低、破 cache 可接受），不建 roster provider。

**不新增 EP**——全部复用 v0.0.22 已落的 `system_prompt_mapper`（ordered）+ v0.0.13 已落的 `system_reminder`（ordered）。

---

## 2. Option A 分流规则（核心契约，不变）

每个 mapper/provider 内部按 `config.sessionType` 分流，不属于当前 scope 直接返回空贡献：

```typescript
function map(ctx: PromptMapperCtx): PromptFragment[] {
  if (ctx.config.sessionType !== EXPECTED_TYPE) return [];   // 不属本 scope，零贡献
  // ...取数据 → 拼 content → 返 [PromptFragment]
}
```

**为什么用 Option A**（不碰 EP scope 激活表）：4 scope 共用 AgentLoop 本体零改；分流逻辑局部于 mapper 文件内；`config.sessionType` 由 `[P1]session_config_studio.md §2` 落进 SessionConfig，mapper 直接读。

> **[v0.0.56 起] 实际实现细节**：`config.sessionType` 字段本身已不存在（被 `config.kind: SessionKind` 取代），上面伪代码的 `EXPECTED_TYPE` 判断在真实代码里读的是 `readSessionType(ctx)`（`prompt/squad_reminder_shared.ts`，`@deprecated` 但仍是全部 12 个 mapper/provider 的唯一分流入口）——从 `kind` 派生旧字符串语义：`kind.isSubagent→'subagent'`；`kind.role==='rocky'→undefined`（**standalone 归一化，[v0.0.153] BUG-004 修复**：此前实现直接 `return k.role` 未归一化，`identity.ts` 用 `!sessionType` 反向判定 standalone 因此误判，见 `../agent/context/log.md` 同日条目）；其余 `kind.role`（`'leader'|'mate'|'squad'`）原样返回。standalone（无 kind 或 role='rocky'）在本表 = `!sessionType` 判定的唯一正确读法。

---

## 3. system_prompt sections（固定规范）

### 3.1 squad_role（NEW，stable，固定规范注入）

**职责**：按 sessionType 注入**固定规范** fragment（角色人设 / rules / 协作规则 / 工具说明）。**动态上下文（workspace 路径 / team-status / roster）不归它**（roster 留 stable mapper §3.2，其余归 reminder §4）。

**分流 + 数据源**（content 文件随代码走、版本管理、可 diff——**不是 DB 字段**，req6 §1/§3）：

| sessionType | 内容文件 | 内容 |
|---|---|---|
| `leader` | `prompts/content/squad/leader.md` | leader 人设 + rules（接需求→拆解→@mate 分配→跟进→收交付；**不直接编码**，技术活 assign mate / spawn subagent）+ 协作（群里 @mate 下达）+ 工具说明 + **presence 维护句**（被唤醒/接任务后先 `presence(set)` 标记当前工作，结束/无事时 `presence(clear)`） |
| `mate` | `prompts/content/squad/mate.md` | mate 人设 + rules（接 leader 分配→自己推进→自己汇报；**不越权**——不擅自做重大决策、不清楚就问）+ 工具说明 + **presence 维护句**（被唤醒/接任务后先 `presence(set)` 标记，结束/无事时 `presence(clear)`——便于 leader 掌握团队状态） |
| `squad`（SquadChat） | `prompts/content/squad/squad_chat.md` | 路由器人设 + rules（**永不创作内容**；按语义路由到 leader / 相关 mate）+ **[v0.0.85]** 转发 3 段模板（说明 / 原文 / 相关上下文，详 `agent_squad_chat.md §2.1`）；`{{squad_name}}` 占位符由 `SquadChatContentHandler.build` 跑 `fillTemplate({{squad_name}} → ctx.config.studioContext.squad.name)` 代码注入（**LLM 把 `{xxx.yyy}` 点号 brace 当字面量 echo**，必须代码替换非 LLM 自填） |
| `subagent` / standalone | — | 返空（subagent 走 parent_task mapper + IdentityHandler；standalone 走 Rocky identity） |

- priority=950，tier=stable，参与 budget_truncate。
- **[v0.0.142] workStyle 追加段**（仅 leader/mate 分支）：`map()` build 完 content 后，读当前 session 自己 member 的 `studioContext.member.workStyle`（`readMemberWorkStyle` duck-typed），非空（trim 后）则追加 `\n\n## 我的工作方式\n\n{workStyle}`；空则不追加（无悬空标题，非 `{{}}` 模板占位）。**仅 leader/mate**（squad 群聊 `studioContext.member===undefined`、subagent/standalone 早 return `[]` → 天然不注入）；**MUST NOT 碰 `team_roster`/`members[]`**（workStyle 是个人 session 专属，不进全队花名册）。仍属同一 `squad_role` fragment（id/tier/priority 不变）。字段语义 + 仅用户可编辑豁免见 `[P1]data_model.md §1.2c`。
- **与 identity.ts / rules.ts 的衔接**（member.systemPrompt 移除后，§7）：identity.ts studio 分支（leader/mate/squad）返空、rules.ts studio 分支返空（squad_role mapper 接管身份正文 + 角色规则，避免与通用 rules.md 重复）；standalone 分支不变（identity→Rocky identity / rules→通用 rules.md）。
- **leader.md / mate.md / squad_chat.md 无 frontmatter**：各 handler `build()` 直接 `readContent()` 塞正文（`squad_chat.md` 额外跑 `fillTemplate` 替换 `{{squad_name}}`）。leader 默认 intro 由 `squad-service.defaultLeaderIntro()` 提供代码固定文案，与 `leader.md` 正文解耦（不从 frontmatter 派生，见 `[P1]data_model.md §1.2a`）。

**协作规则内容**（req6 §4，写进 mate.md / leader.md rules 段）：
- mate → leader（问老板）：卡住 / 需求不清 / 需越权 → 在团队群聊（SquadChat）@leader 问（**不走神秘直连**，全员可见可追溯）。
- leader → mate（下达）：群里 @mate 分配 / 追问 / 确认。peer（mate↔mate）：群里协作、交接。user → 团队：群聊提需求 → SquadChat 路由 leader。
- 注：SquadChat 路由 = **LLM 驱动哑路由**（非确定性，req13 I5），协作回路可靠性留后续版本。

### 3.2 team_roster（非 subagent，stable，不变 + req13 C6）

**留 stable system_prompt mapper**（不建 provider）。数据源：`config.studioContext.members`（bootstrap 注入的完整 MemberRecord 数组，含 `intro`）→ 渲染 `{name, role, sessionId, intro}` 花名册；兜底读 `config.studioContext.member` + `squad.memberIds` 列其余 id。

**渲染格式**（`team_roster.ts renderRoster`，leader 排在前）：每行 `- {name}({role}) (sessionId: {sid}) — {intro}`。`intro` 一句话介绍追加行尾用 ` — ` 分隔；**intro 缺省时优雅降级不显示分隔符**（旧 member 无此字段）。intro 随完整 MemberRecord 从 bootstrap → `studioContext.members` 整记录透传流入（mapper 不直接持 memberStore，依赖方向约束）。

**bench 过滤**：渲染前在 `readRoster()` 单点过滤 `state !== 'benched'`（duck-typed——state 缺失按 deployed 对待，兼容无 state 字段的旧数据，防全灭）；benched 成员不出现在花名册。数据源（`studioContext.members`）与渲染格式不变，仅在消费点加一层 deployed-only 过滤。判据用 `!== 'benched'` 而非严格 `=== 'deployed'`：plugin 侧读 untyped JSON，旧 fixture/旧注入可能缺 state 字段，显式 benched 才隐藏更稳健（生产数据 state required，两判据等价）。

**为什么不进 reminder**（req13 C6）：roster 仅 hire/bench/edit 才变，频率低；放 stable section cache 友好（破 cache 可接受）；省一个 provider + 去重逻辑。subagent 不可见（拓扑硬约束只回 parent）。

### 3.3 parent_task（subagent only，stable，不变）

**数据源**：spawn 入参 `task`（`SpawnAgentInput.task`，`../multi_agent/[P1]subagent_derivation.md §4`）→ 持久化进 subAgentConfig 扩字段 → mapper 从该扩字段读。subagent only（其他 scope 不贡献）。

---

## 4. system_reminder sections（动态补充）

**2 个 squad provider**（详细产出格式 + 角色 filter → **`[P1]squad_reminder_providers.md`**）：

| provider | leader | mate | SquadChat | 数据源 |
|---|---|---|---|---|
| `squad_workspace`（v0.0.111） | 团队盘根路径 | 团队盘根路径 | — | `config.squadId + dataDir` 推路径 |
| `squad_team_status`（[v0.0.116]） | running 成员 + presence | — | — | `members` ∩ running session + `member.currentWork` |

加现有 `reachable_agents` provider（§5，不变）。

> **`squad_team_status`**（leader「团队当前状态」段）：只列 session 正在 running 的成员 + 各自 presence 标记（`member.currentWork`，可能为空）。运行时瞬时态，不做变化检测（每轮直接产出交 dedup，类同 `squad_workspace`）。详 `squad_reminder_providers.md §3`。

**两个 provider 都不走 shouldProduce 变化检测**（路径静态 / running 是瞬时值），每轮产出交 dedup reducer 收敛。

**roster 不进 reminder**（req13 C6，§3.2）。

---

## 5. reachable_agents（system_reminder，deployed-only）

EP=`system_reminder`（D7）。hire/bench/edit 后即变，放 system_prompt 破 cache；放 reminder 只影响该 turn。派生表与 `../multi_agent/[P1]a2a_protocol.md §3` 1:1：

| caller sessionType | reachable_agents |
|---|---|
| `squad` | `[leader, ...deployed mates]` |
| `leader` | `[squadchat, ...deployed mates]` |
| `mate` | `[squadchat, leader, ...deployed peers]` |
| `subagent` | `[parent]` |
| standalone（`!sessionType`） | `[]` |

**硬约束**：**user 永不在 reachable_agents 列表**（agent↔user 不走 send_message）。

**bench 过滤（修真 bug）**：benched 成员无心跳不运行，列为 `send_message` 对端无意义（过去把 bench 当可达对端 = 真 bug）。过滤单点在 `reachable_agents.ts readMembers()` 返回前——`state !== 'benched'`（duck-typed，同 team_roster 判据）；派生表结构（`derive`/`deriveSquadScoped`）零改，mates/peers 自动收缩到 deployed。subagent `[parent]` 分支不受影响（拓扑硬约束）。

---

## 6. system prompt 生命周期（req8 §2/§9，NEW）

| 阶段 | 动作 |
|---|---|
| **session run 启动** | `buildSystemPrompt` 构建固定规范 system（**一次**，**纯固定、不含动态**——squad_role + roster + parent_task + 通用 mapper）；**启动即注入首条 reminder** 承载初始动态快照（避免 system 与 reminder 信息重复） |
| **loop 内** | system **不重新构建**（稳定 → 利 prompt caching → 省 token/延迟）。现状"每轮 assemble 重建 system"需改为**启动构建 + 缓存** |
| **动态变化** | running 态 / 路径变化 → ingest 时追加一条 system reminder（squad_team_status / squad_workspace provider 决策，**不重建 system**） |
| **compaction** | **assemble 层逻辑**（本 spec 不细化实现）；**compaction 后必须重建 system prompt**，触发 = **summary 版本 ≠ snapshot 已有版本** → 重跑 buildSystemPrompt（固定）+ 注入当前态 reminder 基线 |

---

## 7. member.systemPrompt 移除迁移（req6 §1 + req13 C1，NEW）

**现状**：v0.0.33.2 把 `member.systemPrompt` 接通成 leader/mate system prompt 身份正文来源（`session-config.ts:231` studio 分支 → `config.systemPrompt` → `identity.ts:37-39`）。5 写入点全活：`squad-service.ts:163` / `member-service.ts:84,102` / `handlers/member.ts:199` / `spawn-action.ts:105`；额外 `team-tool.ts:144` `systemPromptSummary`（team.query 返 LLM）。

**方向**：移除 `member.systemPrompt`（不落库——system prompt 是组装出来的结构，非 DB 字段），由 squad_role mapper + content fragment 接管。

**迁移顺序（3 步，不能直接删字段）**：
1. **先建 squad_role mapper** + `prompts/content/squad/{leader,mate,squad_chat}.md` fragment（§3.1）。identity.ts / rules.ts studio 分支加 Option A 分流（返空，让 squad_role 接管）。此步 member.systemPrompt 字段仍在（双源，可灰度）。
2. **切 identity.ts studio 分支**：从 `config.systemPrompt`（member.systemPrompt）→ 返空（squad_role mapper 接管身份正文）。验证 leader/mate 人设来自 fragment 正常。
3. **再删 member.systemPrompt**：
   - entity schema 去 `systemPrompt` 字段（`[P1]data_model.md §1.2`）。
   - 5 写入点全部去掉 systemPrompt 写入。
   - `team-tool.ts:144` `systemPromptSummary` 字段移除（team.query 不再返）。
   - `createSquad` / `hire` input schema 的 `systemPrompt` 必填约束去掉（`[P1]data_model.md §4/§5`）。
   - **derive 模式语义变更**（`member-service.ts:102`）：原复制 `parent.systemPrompt` → 改为复制 `parent.{role(降级为 mate), tools, skills, model}`（**配置继承，非 prompt 继承**）。

**回滚**：步骤 2 失败 → identity.ts 回退读 `config.systemPrompt`（字段仍在）；步骤 3 字段删除后不可回滚（须确保步骤 2 稳定后再删）。

---

## 8. 工作目录组织建议（okf 轻量建议）

squad 工作目录内容组织是**轻量建议**（非强制结构、无后台投影、工具不依赖文件布局）：
- **okf 方法作为可选组织建议**——agent 可用 okf（index.md / log.md + type frontmatter + 坏链容忍）组织知识，方法见 `okf-skill` + `[P1]squad_okf.md`；也可朴素 markdown。
- **区分交付与草稿**：建议 `交付/`（最终成果）与 `temp/`（草稿/试错）分开，命名带日期版本（如 `方案-20260802.md`）。
- **工具与工作目录解耦**：agent 工具（team / presence / todo / panorama）不读不写 okf 文件结构；okf 是 agent 工作笔记面，工具是结构化数据面，两者无同步约束。

> leader.md / mate.md 已含轻量工作目录组织建议（v0.0.237 重写，去「OKF=工作目录 / store=汇报PPT」双轨制 + 5 类强管）。

---

## 9. plugin.json 注册（T3 落，updated）

`app/plugins/builtins/rocky_context/plugin.json`：
- `system_prompt_mapper` EP squad impl：`squad_role` / `team_roster` / `parent_task`。
- `system_reminder` EP squad impl：`squad_workspace`（v0.0.111）/ `squad_team_status`（[v0.0.116]，leader team-status）/ `reachable_agents`（existing）。

**effective order**：squad_role 排 stable 段（identity/rules 之后，tool_guidance 之前）；reminder provider 顺序不影响（injector 聚合为单 block）。

---

## 10. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| 固定 vs 动态归属 + 贡献点总表 + squad_role/roster/parent_task section + 生命周期 + systemPrompt 迁移 + 工作目录组织建议 | 本文 ✅ |
| squad_workspace / squad_team_status provider 详细（产出格式 / 角色 filter / ReminderCtx 扩展） | `[P1]squad_reminder_providers.md` |
| SessionConfig.sessionType + studioContext 字段 | `[P1]session_config_studio.md` |
| PromptFragment / PromptTier / mapper EP 契约 | `../agent/context/[P0]system_prompt.md` |
| SystemReminder / system_reminder EP / ReminderCtx | `../agent/context/[P0]system_reminder.md` |
| reachable_agents 派生 + AgentRef + 别名解析 | `../multi_agent/[P1]a2a_protocol.md §2/§3` |
| Squad/Member entity（memberIds、role、workStyle） | `[P1]data_model.md §1.1/§1.2` |
| okf 文档组织建议（轻量非强制） | `[P1]squad_okf.md` |
| 工具 actions（team/presence + member 写 action service 单源） | `[P1]squad_tools.md` |
| spawn 入参 task（parent_task 数据源） | `../multi_agent/[P1]subagent_derivation.md §4` |

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
