# v0.0.33.2 PRD 变更日志 — 4 scope 对话能力打通

## 概述

v0.0.33.1 已立 squad 层「数据 + 存储 + 管理」骨架（CRUD + Studio UI 全实跑，对话全占位 403）。本版本把占位拆掉：**squad / leader / mate / subagent 4 scope 全部以新统一架构工作**——共用一套 `SystemPromptBuilder`（mapper/reducer 链，v0.0.22 已就绪）+ a2a 协议（v0.0.31 已落）+ reachable_agents 动态注入 + `<EOS>` 协议。Studio 内所有 chat 入口替换为真聊。

**一句话定位**：用户在 Studio 群聊发消息 → SquadChat 路由 → leader/mate 真回复；单聊 leader/mate 真对话；leader↔mate、mate↔peer、mate→subagent 全链路协作打通；4 scope 共用同一 agent loop（loop 本体零改，差异在 prompt build + 工具集）。

**父版本**：v0.0.33（squad 启动）；**地基依赖**：v0.0.33.1（数据模型 / 目录 / 占位 chat 路径）+ v0.0.28（spawn_agent / send_message / subagent 框架）+ v0.0.31（a2a 协议 / reachable_agents / deliverTo 统一投递）。

**权威输入**：`reqs/v0.0.33.2/{req1,req2}.md` + `states/v0.0.33.2/user_query.md` + 架构调研 `specs/research/v0.0.33.2-dialogue-architecture.md`（D1-D10 锁定决策）。技术细节由 architect 落 `specs/tech/version_logs/v0.0.33.2/`，本 PRD 只描述诉求 + 引用已有概念。

> **命名一律 `mate`**（session.type / role / 字段名），对齐权威 spec + .1 已落。req2 仍用 `member` 是过时草稿，本文已按 research §2 修正。

---

## 1. 版本目标 [v0.0.33.2]

1. **拆占位 403**：移除 `session-messages.ts` 对 studio session 的 `403 studio_chat_not_ready` 分支；squad/leader/mate session 接入 agent loop。**subagent 403 保留**（只读语义是设计不变量）。
2. **4 scope 共用统一架构**：复用现有 `SystemPromptBuilder`（mapper/reducer 链）+ 单一 type-无关 eager `AgentLoop`（loop 本体零改）；差异只在 prompt build（按 sessionType 内部分流的 mapper）+ 工具集（schema 层裁剪）。
3. **配置消费落地**：`buildSessionConfigFromDeps` 加 studio 分支，从 member/squad entity 取 `systemPrompt / tools / skills / model` 注入 SessionConfig；member/squad 字段早已持久化（.1 落地），数据就绪，缺消费方。
4. **`<EOS>` 协议落地**：SquadChat 哑路由的静默结束机制（stop seq 优先 + 后处理 strip 兜底，双保险）。
5. **subagent 迁统一框架**：v0.0.28 subagent 体系迁到 4-scope 统一 prompt builder；**修 identity 覆盖 bug**（`subAgentConfig.systemPrompt` 被 Rocky identity mapper 覆盖，从没到 LLM）；保 100% backward compat（v0.0.28 全部 case 回归 PASS）。
6. **a2a 协议 squad clique 校验**：squad/leader/mate 互相可达 + 跨 squad 拒绝；reachable_agents 运行时派生（不硬编码）。
7. **角色面板"记忆管理"实跑**（v1 占位）：transcript summary + 触发 compact。
8. **skill 黑白名单 + 模型 default/override 落消费层**（字段已就绪）。

---

## 2. 范围（模块清单）

### 2.1 IN SCOPE（11 条必做，对齐 research §4）

| 编号 | 模块 | 描述 | 权威概念 spec |
|---|---|---|---|
| **A** | 拆占位 403 + 接 agent loop | studio session POST messages 进 AgentManager.activate（不再返 403）；subagent 403 保留 | `session_biztype` + `[P1]subagent_derivation §2` |
| **B** | SessionConfig 加 studio 分支 | `buildSessionConfigFromDeps` 从 member/squad entity 取 systemPrompt/tools/skills/model；SessionConfig 加 type/bizType/squadId/memberId 字段 | `[P1]data_model §1.2/§1.4` + research §3 D3 |
| **C** | 工具 schema 层裁剪 | assemble snapshot.tools 按 type 过滤 toolDefinitions；`scope-allowed-tools` 扩 case（轻量裁剪，非 EP 化） | `[P1]squad_tools` + research §3 D2 |
| **D** | 统一 prompt builder 接 4 scope | 新 section mapper（charter leader-only / team_roster / reachable_agents→reminder / parent_task for subagent / tasks 占位）+ mapper 内 Option A 分流（`if(config.sessionType!==X) return []`） | `[P1]agent_{leader,member,squad_chat}` + `[P1]a2a_protocol §7` |
| **E** | SquadChat 哑路由 + `<EOS>` | 路由分拣 + stop seq `["<EOS>"]` + 后处理 strip 兜底；不新增 StopReason，仍 `no_tool_call → markIdle` | `[P1]squad_definition §6` + `[P1]agent_squad_chat §5.1` |
| **F** | a2a squad clique 拓扑校验 + reachable_agents 派生 | send_message 校验：squad/leader/mate 互相可达 + 跨 squad 拒绝 + parent-subagent 互相可达；user 永不在列表 | `[P1]a2a_protocol §3/§6` |
| **G** | skill 黑白名单 + 模型 default/override | session-config 加 member.skills 交集过滤；resolveProviderModel 回退链加 `member.model ?? squad.modelDefault` | `[P1]data_model §1.2` + research §3 D4/D5 |
| **H** | team 工具只读子集（v2） | leader/mate 持 `team(list/query/get_charter)`；`hire/deploy/bench/edit/update_charter` 留 v3 对话驱动 | `[P1]squad_tools §2` |
| **I** | 前端群聊 UI + 单聊 chat | 群聊消息带角色名前缀（`alice: …`）/ 头像，user 输入区正常；单聊 leader/mate 复用 playground chat UI（无前缀）；a2a 消息直读 inbox 透传；subagent 树沿用 v0.0.28 展示规则（照搬） | `06-studio §5` + `chat-page/_overview.md` |
| **J** | 角色面板"记忆管理"实跑 | transcript 摘要 + 触发 compact / 清空记忆（接 v0.0.18 summary 机制） | `06-studio §4.3` + `member-panel.md` |
| **K** | subagent 迁统一框架 + 修 identity bug | subagent identity 走统一 identity mapper 读 `config.systemPrompt`（explorer），不再被 Rocky identity 覆盖；保留 parent_task/reachable(parent) section；v0.0.28 全 case 回归 PASS | `[P1]subagent_derivation` + research §3 D9 |

### 2.2 视觉保真口径（无设计稿）

`reqs/v0.0.33.2/` 下**没有**设计稿（.1 的 6 个 html 是 CRUD UI，不是对话 UI）。群聊 UI 视觉属新设计——本版本**不强制视觉保真 compare**，按 `06-studio.md` spec + `chat-page` playground chat 既有视觉对齐（user 右深底气泡 / agent 左 accent-surface 气泡 / tool-batch 合并胶囊 等）。群聊特化（角色名前缀 + a2a 消息透传）的视觉细节由 coder 编码前补组件 spec「视觉基线」字段（先 spec 后实现）。

---

## 3. 架构决策（research §3 D1-D10，PRD 据此）

| # | 决策 | 取舍 | 理由 |
|---|---|---|---|
| **D1** | **scope 化（req1 想法 a/b）** | **不做** | `session.type + bizType + parentSessionId` 已 1:1 表达 6 类；scope 是静态配置层管不了动态差异（reachable_agents/tasks/charter 运行时算）；用户直觉「不值得」+ 调研印证；省一层 type↔scopeId 双源维护。req1 用户预授权「我都能接受」但倾向不值得，PRD gate 让用户复核确认 |
| **D2** | **工具可见性** | 轻量 schema 层裁剪 | assemble snapshot.tools 按 type 过滤 toolDefinitions；EP 化是未来增强，schema 裁剪成本 1/10 达成同样可见性（让 LLM 看不到无关工具） |
| **D3** | **scope 分流机制** | Option A：mapper 内分流 | `if(config.sessionType !== X) return []`；SessionConfig 加 sessionType/bizType/squadId/memberId 字段；避免碰 EP scope 激活表；mapper 已独立，内部分流零架构改动 |
| **D4** | **skill 黑白名单（req1 c）** | 做 | session-config 加 member.skills 交集过滤；字段已就绪（`member.skills`），改动小 |
| **D5** | **模型 default+override（req1 d）** | 做 | resolveProviderModel 回退链加 `member.model ?? squad.modelDefault`；字段已就绪 |
| **D6** | **charter 投递（TBD#1 拍板）** | **charter = stable system_prompt section，leader only** | charter 稳定低频（per-squad），放 prompt 不破 cache；leader 专属、mate 不见（spec `squad_definition §5`） |
| **D7** | **reachable_agents tier（TBD 拍板）** | **volatile → system_reminder**（非 system_prompt） | hire/bench 后下个 assemble 即变，放 prompt 会破 cache；workspace/time 已走 reminder 先例 |
| **D8** | **`<EOS>` 实现（TBD#3 拍板）** | **stop seq 优先 + 后处理 strip 兜底**（双保险） | provider 支持 stop seq → 配 `stop=["<EOS>"]` 自然停；不支持 → final text 后处理 strip；不新增 StopReason，仍 `no_tool_call → markIdle` |
| **D9** | **subagent identity bug** | 修 | subagent identity 走统一 identity mapper 读 `config.systemPrompt`（explorer 人设），不再被 Rocky identity 覆盖；保留 parent_task/reachable(parent) section；行为对齐 spec（subagent 有自己人设） |
| **D10** | **命名** | **mate（非 member）** | PRD/architecture/代码一律 mate；对齐权威 spec + .1 已落 |

> **D1 取舍说明**：req1 想法 a/b（agent 差异完全靠 extension scope 承接，6 个 scope：playground-parent/playground-subagent/studio-squad/studio-leader/studio-mate/studio-subagent + 工具改 extension point）——调研印证**不值得**：scope 体系目前空转（6 个 scope 名只在 req1 出现，零落地），且 scope 是静态配置层管不了运行时动态差异（reachable_agents 按 squad 成员算、tasks 按分配算、charter 按 role 算）。统一 mapper 链 + schema 层工具裁剪 + SessionConfig 字段分流已达成 100% 等价功能，省一层 type↔scopeId 双源维护。**forked agent 仍硬编码**（基本不变逻辑，req1 明示排除）。

---

## 4. 4 scope prompt section 组合 + 工具集（对齐 [P1] spec）

### 4.1 system prompt section 组合

| section | squadchat | leader | mate | subagent | 内容来源 |
|---|---|---|---|---|---|
| identity | ✅ 路由器 | ✅ 协调者 | ✅ 执行者（member.systemPrompt） | ✅ explorer（config.systemPrompt，**D9 修**） | member.systemPrompt / subAgentConfig.systemPrompt |
| charter | ❌ | ✅（leader only，**D6**） | ❌（任务驱动） | ❌ | squad.charter（embedded） |
| tasks（带血缘） | ❌ | ❌ | 占位（v3 真填） | ❌ | squad_workitems（v3） |
| parent_task | ❌ | ❌ | ❌ | ✅（spawn 时首任务） | spawn input.task |
| rules | ✅ 路由+EOS | ✅ 管理协议+escalation | ✅ 任务驱动+协作 | ✅ subagent 协议 | 各 agent_rules spec |
| reachable_agents | ✅（**D7 reminder**） | ✅ reminder | ✅ reminder | ✅（仅 parent） | a2a §3 动态派生 |
| team_roster（花名册） | ✅（路由要） | ✅ | ✅（peer 协作） | ❌ | squad.memberIds |
| skills | ❌ | ✅ 管理/规划 | ✅ 业务 | ❌ | member.skills（**D4 黑白名单**） |
| tool_guidance | ✅ send_message | ✅ 全协调工具 | ✅ send+spawn+业务 | ✅（explorer 工具） | 按 type 裁剪后工具集 |
| context_files | ❌ | ✅ board占位+reports | ✅ workspace | ❌ | workspace 路径 |
| memory | ❌ | ✅ 长期 | ✅ 长期 | ✅ | session transcript summary |

> 新概念（spec 现无）：`parent_task` section（subagent prompt 用）、`team_roster` section 名 —— **需 architecture 阶段落 tech spec**（已标 `a2a §7` 列出但无独立 mapper spec）。

### 4.2 工具集（v2 子集，对齐 squad_tools；workitems 工具 v3）

| Scope | 工具（v2） | v3+ 留项 |
|---|---|---|
| **squadchat** | `send_message`（→ leader/mate） | — |
| **leader** | `send_message`（→ 全队 + SquadChat）+ `team(list/query/get_charter)` 只读 | v3：`team(hire/deploy/bench/edit/update_charter)` + `goal/requirement/task` |
| **mate** | `send_message`（→ leader/peer/SquadChat）+ `agent(spawn/query/abort)` 仅自己派的 + `team(list/query/get_charter)` 只读 + 业务工具（file/web/bash…） | v3：`task/requirement/goal` 业务子集 |
| **subagent** | 不变（v0.0.28 工具集：read/web_search/web_fetch/send_message），迁框架不改集合 | — |

> leader 不给 `agent` 工具（subagent 是 mate 私产）；squadchat 不给业务工具/agent/team 管理 action。

---

## 5. 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径 = 至少一个 API/E2E case。

| ID | 用户操作链路 | 预期结果 | v2 覆盖 |
|----|---|---|---|
| **UC-1** | 群聊路由：user 在 squadChat 发消息 → SquadChat 路由 leader → leader send_message 回 → 群聊 UI 展示 `leader_name: ...` → SquadChat `<EOS>` 结束 run / session idle | leader 真回复；UI 含角色名前缀；`<EOS>` 被 strip 不展示 | ✅ |
| **UC-2** | 单聊 leader：user 直接打开 leader chat → 发消息 → leader 直接 final text（不经 SquadChat） | leader 在自己 session 出 final text | ✅ |
| **UC-3** | 单聊 mate：同 UC-2，user 直聊 mate | mate 直接 final text | ✅ |
| **UC-4** | Leader → mate 协作：群聊 user 提问 → leader 收到 → leader `send_message(to=mate)` → mate 收到 → mate 回 leader → leader 综合后 send_message 回 SquadChat → 群聊 UI 展示 | 多角色协作链路全通 | ✅ |
| **UC-5** | Mate → peer 通信：mate A `send_message(to=mate B)` → B 收到 → B 回 A | peer 自由通信（Q2） | ✅ |
| **UC-6** | Mate spawn subagent：mate 收到 task → `agent(spawn)` → subagent 干活 → 回 parent mate → mate 收到结果 | mate 派生 + subagent 回报 | ✅ |
| **UC-7** | `<EOS>` 验证：SquadChat 完成路由 → 输出 `<EOS>` → strip 后 UI 不显示 `<EOS>` → session idle → 新消息进 inbox → 重激活 | `<EOS>` 双保险（stop seq + strip）；session 持久 | ✅ |
| **UC-8** | Subagent 迁框架兼容：现有 subagent 在新 4-scope 框架下行为 100% 兼容（v0.0.28 全部 case 回归 PASS） | backward compat 不破坏 | ✅ |
| **UC-9** | Leader → user 升级：leader 按 charter.escalation 主动问 user → leader `send_message(to=SquadChat, needReply=false)` → 群聊 UI 透传 → user 回复 → SquadChat 路由回 leader | 升级路径双向 | ✅ |
| **UC-10** | 角色面板 - 记忆管理：单聊 → 点角色头像进入面板 → 记忆 tab → 看到 transcript summary → 触发 compact → 返回对话验证记忆生效 | v1 占位实跑 | ✅ |
| **UC-11** | reachable_agents 注入：mate A prompt 中 reachable_agents 包含 leader / squadchat / peer mates（不含 user）/ 自己 subagents | 拓扑正确（代码 + e2e 双重验证） | ✅ |
| **UC-12** | bizType 隔离：v2 实聊后，studio chat session 仍**不出现**在 playground 列表 | bizType 三处覆盖（字段 + GET 过滤 + UI 路由） | ✅ |

> 路径 1-11 主要 HTTP + LLM 行为（AT 覆盖，真 LLM 真 squad 实跑）；UC-8 走 v0.0.28 既有 AT/ET 回归；UC-12 走 .1 既有 AT 回归一次确认不破坏。

---

## 6. 用户验收标准

1. **群聊真聊**：在 squadChat 发消息 → leader 真回复（消息走 SquadChat → leader → 群聊 UI 渲染 `leader_name: 回复`），UI 不见 `<EOS>`。
2. **单聊真聊**：单聊 leader/mate → 真对话（不经 SquadChat）。
3. **跨角色协作**：leader `send_message(to=mate)` → mate 真收到、真回；mate spawn subagent → subagent 真干活 → 回 parent mate。
4. **subagent identity 正确**：spawn 出的 subagent LLM 行为对齐 explorer 人设（不再是 Rocky identity）—— AT 用真 LLM 验（subagent 自报身份）。
5. **4 scope 共用 builder**：代码层可验证（4 scope 走同一 `SystemPromptBuilder`，差异在 mapper 分流 + 工具裁剪）。
6. **subagent backward compat**：v0.0.28 全部 AT/ET case 回归 PASS。
7. **记忆管理实跑**：角色面板记忆 tab 看到 transcript summary + compact 触发生效。
8. **bizType 隔离不破坏**：studio session 不污染 playground 列表。
9. **视觉**（无设计稿，不强制 compare）：群聊 UI 按 `06-studio` + playground chat 既有视觉对齐；功能层 PASS 即验收。

---

## 7. 显式排除（v3/v4 不做项）

| 排除项 | 承接版本 | 理由 |
|---|---|---|
| Workitems（goal/requirement/task）store + 工具 | v0.0.33.3 | tasks section 占位即可；OKR/Req/Task 实体 + 看板留 v3 |
| 看板视图 | v0.0.33.3 | 同上 |
| Leader 对话驱动 `update_charter` | v0.0.33.3 | v2 charter 仅"v1 UI 编辑过的内容注入 leader prompt"，不动态演化 |
| `team(hire/deploy/bench/edit)` LLM 工具 | v0.0.33.3 | v2 仅 `team(list/query/get_charter)` 只读；管理动作仍走 HTTP + UI |
| 心跳 / scheduler / budget gate / autonomy 实际生效 | v0.0.33.4 | 字段占位（.1 已落），scheduler 留 v4 |
| file-watch 唤醒 | v0.0.33.4 | reactive only（无心跳）足够 v2 |
| tasks section / current task section 真实填充 | v0.0.33.3 | v2 占位（mate prompt 不见 task，仍可被 user 直聊或 leader send_message 协作） |
| 视觉保真 compare（无设计稿） | — | reqs/v0.0.33.2/ 无设计稿，按 06-studio + chat-page 既有视觉对齐 |
| Multi-target send_message（fanout） | 不做 | v2 保单目标；spec 留口子未来再评估 |

---

## 8. 风险点 / 设计注意

- **subagent identity 修复改变现有行为**：现 subagent 实际生效的是 Rocky identity（bug）；修后是 explorer 人设。**必须**跑 v0.0.28 全部 subagent case 回归 PASS 才能合并；AT 用真 LLM 验（subagent 自报身份）。
- **charter/reachable tier 决策影响 cache 命中率**：D6（charter=stable prompt section）/ D7（reachable=volatile reminder）已定。
- **workspace 隔离**：playground 用 `data_dir/workspaces/<sid>`，mate 用 `squads/{squadId}/workspaces/{memberId}/`；buildSessionConfigFromDeps workdir 取法需兼容（research §6）。
- **双重工具过滤一致性**：subagent 现在 config.tools 白名单 + scope allowedTools 双过滤；studio session 只走 config.tools 白名单要确认不破坏 subagent 语义。
- **群聊 UI 消息源标识**：消息有 sender.source（user/agent）+ sender.agent.ref，UI 渲染要正确区分 user/角色发送 + 角色名前缀。
- **session.type 路径完整**：所有 session 创建路径（建 squad / hire / spawn）都正确填 type + bizType（.1 已落，v2 消费层核对一次）。
- **`<EOS>` provider 兼容**：多 provider 实测（Claude/GPT/DeepSeek/Gemini），不支持的兜底 strip 路径必须可靠。

---

## 9. spec 对齐问题（留 orchestrator / architecture 阶段处理）

PRD 对齐 ui/tech spec 自检发现以下问题（PRD 不擅自改 spec，仅记录）：

1. **`agents_comparison.md` 残留 `session.type=member`**（应为 `mate`）+ 标题 `Member` 应为执行者 mate —— research §11 已标 spec 卫生项。**待 spec 卫生修**（doc-modifier 阶段 5 或 architect 阶段一并修）。
2. **`squad_workspace.md` 残留 `.rocky_squad/charter.md` + `members.yaml` 可读文件名**（.1 已推翻，全走 store `{id}.json`）—— research §11 已标。**待 spec 卫生修**。
3. **`squad_tools.md` §2 仍提"注册到 `.rocky_squad/members.yaml`"** + §2.1 "写 `.rocky_squad/charter.md`" —— 与 data_model §3 存储布局冲突（store `{id}.json`）。**待 spec 卫生修**（v2 不动文件名引用，但需注释说明"概念文件名，实际走 store"）。
4. **新 section 名待落 tech spec**：`parent_task`（subagent prompt）、`team_roster`（花名册）—— `a2a §7` 列出但无独立 mapper spec。**需 architecture 阶段落 tech spec**（落 `specs/tech/version_logs/v0.0.33.2/change_log.md` + 同步 multi_agent/squad overall）。
5. **SessionConfig 加 type/bizType/squadId/memberId 字段** —— 现有 `context-types.ts:70-153` SessionConfig 无此字段。**需 architecture 阶段落 tech spec**。
6. **`<EOS>` 实现 layer** —— stop seq 配在哪一层（provider caller / agent-loop）、后处理 strip 写在哪一层（agent-loop / message-persist），TBD#3 PRD 已拍板"双保险"但实现位置归 architecture。

---

## 10. 版本

version: 1.0 `[v0.0.33.2]`（4 scope 对话打通首版 PRD：①§1 8 目标（拆 403 / 共用 builder / 配置消费 / `<EOS>` / subagent 迁框架修 identity bug / a2a squad clique / 记忆管理实跑 / skill+model 落消费）；②§2 11 条必做 + 视觉保真口径（无设计稿，按 06-studio + chat-page 既有视觉对齐）；③§3 D1-D10 架构决策（含 D1 不做 scope 化的取舍说明）；④§4 4 scope prompt section 组合 + 工具集（v2 子集 vs v3 留项）；⑤§5 12 条关键用户路径（含群聊路由 / 单聊 / leader↔mate / mate↔peer / mate→subagent / `<EOS>` / subagent backward compat / reachable 注入 / bizType 隔离 / 记忆管理）；⑥§6 9 条验收标准；⑦§7 v3/v4 显式排除；⑧§8 风险点；⑨§9 spec 对齐问题（member 残留 / 新 section 待落 tech spec）。基于 req1+req2 + research §3 D1-D10 + 权威 spec（squad / multi_agent）。命名一律 mate。）
