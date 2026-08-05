---
type: spec
title: Squad 目录结构（团队办公室）
priority: P1
status: active
updated: 2026-08-02
since: v0.0.33.1
---

# Squad 目录结构（团队"办公室"）

> 定位：squad 的**结构化文件目录**——一个团队的"办公室"。结构化为**新 hire 能 onboard**（找得到产出/自己 workspace/历史），无需任何人专门教。
> 参考：`[P1]data_model.md §3`（存储布局权威）；`[P1]squad_okf.md`（okf 文档组织建议）；`../agent/session/[P0]session_store.md`；workspace 特性（v0.0.17：session.workspaceDir + file-watch）。
> 哲学：**真实团队隐喻**——真实团队有共享盘 + 公告栏 + 产出库 + 周报；本目录是它的形式化表达。

---

## 1. 目录布局

> 系统内部数据（scheduler/budget/history state + memory + skills）统一收口 `.rocky/`（**`.rocky/` = rocky app 数据在对象 ws 里的存放位置**，旧 `.rocky_squad/` 已改名 `.rocky/`，存量由 MigrationManager `squad-rocky-dir` 平移）。布局权威 = `[P1]data_model.md §3`。
> okf 知识库（index.md / log.md / 各 type md）是 agent **自愿组织**的轻量建议（非强制，无后台投影），详 `[P1]squad_okf.md`。

```
data_dir/
├── squad/{squadId}.json                # store：squad record（CrudStore entity='squad' 不分片，单数目录；与下方 office 分离）
└── squads/{squadId}/                   # squad「办公室」
    ├── (okf 知识库 — agent 自愿组织，非强制；index.md / log.md / *.md，详 squad_okf §1)
    ├── members/{memberId}.json         # store：member records（按 squadId 分片，entity='members' 复数）
    ├── 交付/                            # 最终成果（用户可感、可交付的产出）
    ├── temp/                            # 草稿 / 试错 / 中间产物
    ├── outputs/                        # 公共产出（公共 deliverables）
    ├── reports/                        # 报告——按类型分（okf type: report）
    │   ├── daily/{YYYY-MM-DD}.md       # 日会日报（per-day）
    │   └── ...
    ├── AGENTS.md                       # 团队 AGENTS.md（全员注入，用户手写；可选）
    ├── workspaces/{memberId}/          # 【已废止·存量保留】旧个人工位（v0.0.232 起不再新建；存量目录平台不迁移不清理，用户自行合并）
    └── .rocky/                         # 系统内部（隐藏，建队时建骨架）：state/（scheduler/budget/history）+ memory/ + skills/ + agents/
```

> **无 `inbox/` 目录**——见 §3。
> **`.rocky/` 只放系统内部数据**：state（scheduler.json/history.jsonl/budget-state.json）+ memory/（per-entry md，group scope 记忆）+ skills/（group 级 skill）+ agents/（per-member 个人差异 AGENTS 文件 `{名字}-{memberId}.md`，按需存在，用户手写）——member 注册表走 `members/{id}.json`、counters 无（board 已删）。旧 `.rocky_squad/` 已改名 `.rocky/`（存量由 MigrationManager `squad-rocky-dir` handler 平移）。
> **团队 workspace 简化模型（v0.0.232）**：squad 全部 session（leader/mate/群聊）的 `session.workspaceDir` 统一指向**团队根 `squads/{squadId}/`**——不再创建 `workspaces/{memberId}/` 个人工位。分层配置布局：团队 AGENTS.md = 根 `AGENTS.md`（全员注入）；个人差异 = `.rocky/agents/{名字}-{memberId}.md`（按需存在，叠加注入）；团队 skills = `.rocky/skills/`；团队级 memory = `.rocky/memory/`（group scope）。存量个人 ws 目录平台不做任何自动迁移/合并/清理（防破坏性运行时迁移），用户自行处理。
> **轻量内容管理（v0.0.237）**：建议区分 `交付/`（最终成果）与 `temp/`（草稿/试错），命名带日期版本；okf 方法作为可选组织建议（见 `squad_okf.md`），不强制 5 类骨架。

---

## 2. 各目录职责

| 目录 / 文件 | 性质 | 谁读写 | 说明 |
|---|---|---|---|
| `squad/{squadId}.json`（office 外） | store | 系统 + 工具 | squad record（CrudStore entity='squad' 不分片，落 `data_dir/squad/{squadId}.json`，**不在 office 目录内**；含 memberIds / leaderId / squadChatSessionId / modelDefault，data_model §1.1） |
| `members/{id}.json` | store | 系统 + leader（hire/bench/edit） | member record（按 squadId 分片，data_model §1.2） |
| `交付/` | 公共 | 全员产出 | 最终成果汇集（v0.0.237 新增建议目录） |
| `temp/` | 公共 | 全员产出 | 草稿/试错/中间产物（v0.0.237 新增建议目录） |
| `outputs/` | 公共 | 全员产出 | deliverables 汇集处 |
| `reports/{daily,...}/` | okf 公共 | leader / 任务责任 member | 日会日报 / 各类报告（okf type: report，squad_okf §5） |
| `AGENTS.md`（根） | okf 公共 | 用户手写 / 全员只读 | 团队 AGENTS.md——全队共享的角色与规则，对全员注入（context_files 两级读取的团队级，可选） |
| `workspaces/{id}/` | 个人（已废止） | 该员工 | 【存量保留】旧个人工位——v0.0.232 起不再新建；session.workspaceDir 全指向团队根；存量目录不迁移不清理 |
| `.rocky/agents/` | 系统内部·隐藏 | 用户手写 / 对应 member 注入 | per-member 个人差异 AGENTS 文件 `{名字}-{memberId}.md`（按需存在非必有；存在则叠加团队 AGENTS.md 注入，团队在前个人在后） |
| `.rocky/` | 系统内部·隐藏 | 系统 | state（scheduler/budget/history）+ memory（group scope 记忆 per-entry md）+ skills（group 级 skill）+ agents（个人差异 AGENTS）（建队时建骨架；旧 `.rocky_squad/` 改名） |

---

## 3. 输入机制：无 inbox 目录，复用 session 消息 inbox

**squad 目录不设 `inbox/` 文件夹**——"inbox" 是 agent **session 的消息队列**（`../agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md` 已定义），**必须复用，不独立弄**。

- **用户输入** → 用户向某个 session（群聊/leader/member）**发消息** → 进该 session 的 message inbox → enqueue + activate（multi_agent D5）。**不走文件**。
- **角色间输入** → `send_message` → 目标 session inbox（同上）。
- **文件输入**（用户要给团队文件）→ 放进 `交付/` / `temp/` / `outputs/`（按用途），不是 inbox。

> 一句话：**消息走 inbox（session 内），文件走工作目录（文件系统）**，两套不混。

---

## 4. workspace 可见性层级

不同角色在工作目录的**可读 / 可写子集不同**。本版本**skill 软约束**（规则写进 okf-skill + squad_role prompt），实现时可加文件系统**硬约束**（路径权限 / 沙箱，TBD）。

| 角色 | 可读 | 可写 |
|---|---|---|
| **leader** | **全队**：整个工作目录 + 根 `AGENTS.md` + `.rocky/agents/` | `交付/` / `temp/` / `outputs/` / `reports/` + 全队工作文件 |
| **mate** | 工作目录（透明只读，含他人产出）+ 根 `AGENTS.md` | 自己产出（建议落 `outputs/{self.name}/` 前缀或 `交付/`）+ 自己 `reports/` |
| **subagent** | **parent 可读子集**（受 parent scope 限制，multi_agent scope=EP，D8） | parent 允许的子集 |

> v0.0.232 起全员 workspaceDir = 团队根，「个人工位」可见性维度消解——文件操作全落团队目录，协作纪律（不写他人产出、产出落 `outputs/{self.name}/` 前缀）靠 skill 软约束，不再有物理隔离的 per-member 目录。

- **透明度**：mate 能**看**全队产出，但产出归属靠命名前缀自律。
- **subagent scope**：parent（leader/mate）派生 subagent 时 scope 限定的路径子集，subagent 不可越 parent 可见范围。

### 4.1 约束实现路线

- **软约束（必做）**：可见性规则写进 `okf-skill` + squad_role prompt（leader.md / mate.md）——skill/prompt 教 agent"你只能读写哪些路径"，靠 agent 自觉遵守。
- **硬约束（TBD，后续版本）**：文件系统级路径权限 / 沙箱（file tools 按 caller 角色过滤路径），防 agent 越权。本版本不硬化。

---

## 5. 接现有 feature

- **workspace（v0.0.17 / v0.0.232 简化）**：每个 member/leader session 的 `workspaceDir` = `data_dir/squads/{squadId}/`（**团队根**——v0.0.232 起全队共用；此前为 `workspaces/{memberId}/` 个人工位，已废止）。群聊 session 同样指向团队根。academy/playground 不受影响。
- **file-watch（per-session 前台 watcher，v0.0.17）**：监 `session.workspaceDir`（v0.0.232 起 = 团队根 `squads/{squadId}/`），lazy SSE-driven，100ms debounce → `session_workspace_file_changed` → **仅 UI 刷新**（权威 = `../agent/session/[P0]session_workspace_manager.md`）。
- **持久化**：整个 squad 目录在 `data_dir`（已按 env 隔离 test/dev/prod），天然持久；系统状态恢复点 = `.rocky/state/scheduler.json`（scheduler lastFiredAt，squad-store 建队即建 `.rocky/state/`）。

---

## 6. Onboarding 流程（新 hire 一个 member）

```
1. hire member（leader/user 发起）→ 建 session（type=mate, bizType=studio, squadId, memberId, parentSessionId=null）
2. session.workspaceDir = 团队根 squads/{squadId}/（v0.0.232 起不再建 workspaces/{newMemberId}/ 个人工位）
3. 注册到 member store（写 members/{memberId}.json，state=deployed，hire 自动 deploy 无 hired 中间态）
4. member 启动后自行 orientation（读目录即入职，受 §4 可见性约束）：
   - 交付/ + temp/ + outputs/ + reports/（catch up 历史/进展/最终成果）
   - 团队根 AGENTS.md（团队规则）+ 可选 .rocky/agents/{自己名字}-{id}.md（个人差异）
   - 如团队采用 okf：读 index.md 入口
5. leader 分配工作（@member）→ member 接活开干 → 产出落 交付/ 或 outputs/ → 写 reports/
```

→ **目录结构本身就是入职手册**，无需专门 onboarding 对话。

---

## 7. 解散删除边界（dissolveSquad — 保留工作产出 + 删管理性子项）

> **触发**：`DELETE /squad/:id` → `dissolveSquad`（`squad-dissolve.ts`）第④步调 `deleteSquadAdministrativeSubpaths(root, squadId)`（与 `ensureSquadDirSkeleton` 同文件对称：建骨架 vs 删管理性数据）。
> **判据（用户裁决）**：用户可直接看懂、可回收的工作产出**保留**；只有程序能看懂的内部数据 / 索引 / 配置 / 历史**删除**。隐喻：员工离职——他写的代码（产出）不删，员工档案 / 账号（存在记录）删。

**保留**（用户可读工作产出，原地可查可回收）：

| 目录/文件 | 为什么留 |
|---|---|
| `workspaces/{memberId}/` | 【存量】旧个人工位——agent 写的代码 / 文件 / 草稿（用户工作产出铁律；v0.0.232 起不再新建，dissolve 同样保留存量） |
| `交付/` / `temp/` / `outputs/` | 最终成果 / 草稿 / 交付物汇集（用户工作产出铁律） |
| `reports/{daily,...}/` | 日会日报 / 各类报告（okf md 可读主面） |

**删除**（程序内部 / 管理性 / 解散后无用）：

| 目录/文件 | 为什么删 |
|---|---|
| `members/*.json` | member 档案（程序性存在记录，解散失效） |
| `charter_history/` | 【存量】charter 变更历史 append-only（程序审计，charter 已删，dissolve 仍清存量残留目录） |
| `panorama/` | DSL 业务全景（纯程序格式 yaml/json/jsonl，需 UI 渲染，无用户可读主面） |
| `.rocky/` | state 调度状态 + memory/ agent 记忆 + skills/ agent 配置（整个目录系统内部） |
| `charter.md` | 【存量】团队章程（charter 已删，dissolve 清残留死文件） |

**语义**：解散 = 注销团队的「存在」（record + members 档案 + 调度状态）+ 清掉程序内部状态，保留用户能看懂的「产出」（workspaces/交付/temp/outputs/reports 原地不动）。

> **过程数据不动**（不进 dissolveSquad 职责）：`dev-logs/` / `langfuse trace` / `search.sqlite` 全局过程数据在 `data_dir` 其他位置，dissolveSquad 只扫 `squads/{squadId}/` 内的管理性子路径，不碰其他。
>
> **会话级联**：dissolveSquad step② 按 `Session.squadId` 平铺查全量 session（含 spawn children）逐个 `deleteSession`——详 `[P0]session_store.md §4` `listSessionsBySquad` 契约 + 调度清潜伏见 `[P1]cron_subsystem.md §8`。

---

## 8. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| squad 目录布局 + 各目录职责 + onboarding + workspace 可见性 | 本文 ✅ |
| 存储布局权威（目录树） | `[P1]data_model.md §3` |
| okf 文档组织建议（index/log + frontmatter + 坏链容忍） | `[P1]squad_okf.md` |
| session message inbox（输入机制） | `../agent/.../[P0]agent_inbox_enqueue.md`（复用） |
| workspace + file-watch | v0.0.17（复用，`../session/` 相关 spec） |
| okf-skill（教 okf 规范给全员，软约束载体） | skill 目录 |

---

## 9. 待定

- `.rocky/state/scheduler.json`（scheduler lastFiredAt，squad-store 建队即建 `.rocky/state/`）。
- `reports/` 各类型的模板/格式（daily 等报告字段，okf type: report body 自由 markdown，模板 TBD）。
- **硬约束**实现（路径权限 / 沙箱按 caller 角色过滤，§4.1，后续版本）。
- squad 目录创建时机（建队即建骨架，data_model §4 step 7）+ 解散保留工作产出 + 删管理性子项（v0.0.192 决 + v0.0.237 去 board/charter：保留 交付/temp/outputs/reports/workspaces；删 members/charter_history/panorama/.rocky + charter.md，详 §7）。

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
