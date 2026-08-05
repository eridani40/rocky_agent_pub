# v0.0.164.memory_opt — memory 治理优化：squad scope + routing 强化 + tier2 质量/lock + 手动触发 — 技术总览

> 引入版本 v0.0.164.memory_opt · 2026-07-17
> 一句话：给 memory + skill + consolidation 三块补 4 项治理短板——memory scope 从 2 值扩到 3 值（加 `squad`，per-squad md 文件 + 6 类注入配额）；skill resolver 加 squad workspace 目录源（内部 SkillScope enum 加 'squad'，对外工具/UI 零改）；`routing_decision.md` 加反例清单 + squad 规则 + project type 澄清（三处共享单一源改一处三处生效）；tier2 prompt 加质量审查段（判据复用 routing 提示词）+ 新引入 `AppTaskLock`（参考 `SessionTaskLock` 形态扩到 app 级，taskType `'tier2_consolidation'`）+ 新增 `POST /consolidation/run` 手动触发端点 + section 加「立即整理」按钮。

> **上游依据**：`specs/prd/version_logs/v0.0.164.memory_opt/change_log.md`（PRD 全文 + 4 项定案 + 4 项用户拍板细节）+ `states/v0.0.164/task-board.md` + `states/v0.0.164/context.md`。

---

## 1. 影响面（受影响 tech KB / api / ui spec）

| Spec | 受影响 | 变更点 |
|---|---|---|
| `specs/tech/agent/memory/index.md` | 增量 | ④ 加原则 15（squad scope 3 值 + 6 类注入配额）；⑤ 导航 tier2 行注 tier2 加质量审查段；`log.md` 追加 v0.0.164.memory_opt 段 |
| `specs/tech/agent/memory/[P0]memory_definition.md` | 增量 | §3 entry scope enum 扩 3 值（`user\|session\|squad`，对外映射 `global\|squad\|session`）；type 说明澄清 project = 长期规则而非进展快照；§2 加第三种介质（per-squad md `<dataDir>/squads/<squadId>/.rocky_squad/memory.md`） |
| `specs/tech/agent/memory/[P0]memory_manage_tool.md` | 增量 | §2 scope enum 扩 3 值 + squad scope 的 `squadId` 从 ctx 自动填（对齐 v0.0.77 sessionId 惯例，input schema 不暴露）；§6 加「无 squad 会话 scope='squad' 直接返 `[invalid_input] not_in_squad`」（用户拍板）；§7.2 加第三种锁策略行（squad = per-file lock on `<dataDir>/squads/<squadId>/.rocky_squad/memory.md`） |
| `specs/tech/agent/memory/[P0]memory_injection.md` | 增量 | §2 加 memory_squad 第三 mapper（tier=stable，比 memory_user 更贴当前 squad 场景）；§2.1 三 mapper 协同（共享 selector 前置，各自读三源）；§2.2 分组从 4 类扩到 6 类（`GROUP_ORDER` 6 值：session 手/自 → squad 手/自 → global 手/自，用户拍板顺序） |
| `specs/tech/agent/memory/[P0]consolidation_tier2.md` | 增量 | §6 加质量审查段（判据复用 `routing_decision.md`：过程快照→archive / scope 选错→建议调整或 archive / 已被覆盖→archive，evolvable=false 仍不动）；§7 加 AppTaskLock 接入（acquire/markDone/markFailed 时机对齐 tier1 lock 惯例）；§10 文件清单加 handler prompt 引用 routing 段 |
| `specs/tech/agent/skills/[P0]skill_definition.md` | 增量 | §4 scope 内部 enum 从 3 值扩到 4 值（`builtin\|app\|workspace\|squad`，对外工具/UI 零改）；§4.1 双层合并 → 三层合并（squad > workspace > app > builtin） |
| `specs/tech/agent/session/[P0]app_task_lock.md` | **新建** | app 级 × per-task 内存锁（`AppTaskLock` class，参考 `SessionTaskLock` 形态扩到 app 级；acquire/markDone/markFailed/release/getState/reconcileOnStartup + CAS + emit `consolidation_task_update` 到新 topic `app_task`）；本版本唯一新概念 |
| `specs/tech/agent/session/index.md` | 增量 | ⑤ 导航加 `app_task_lock.md` 行；④ 加原则 11（app 级后台任务互斥用 AppTaskLock，形态对齐 SessionTaskLock）；`log.md` 追加 v0.0.164.memory_opt 段 |
| `specs/tech/scheduling/[P1]consolidation_job.md` | 增量 | §4 gate chain 加 AppTaskLock.acquire 步；§7 加手动触发路径（cron/手动同一段 tier2 job 代码，仅触发源不同）；§6 文件清单补 consolidation-run handler 行 |
| `specs/api/overall/03-config-center.md` | 增量 | 新增 §2.8 `POST /consolidation/run`（fire-and-forget，AppTaskLock 保护，202/409）；§5 文件清单补 router.ts + 新 handler 行 |
| `specs/ui/components/app-dev-config-page/section-consolidation-config.md` | 增量 | 新增「立即整理」按钮 testid + disabled 逻辑 + SSE 订阅 `consolidation_task_update` 事件；废除现有「不提供该交互」边界注记 |
| `app/server/src/prompts/content/routing_decision.md` | 修改 | 步骤 1 加反例清单（进展/状态/成就/情绪/短期不写）+ project type 定义澄清；步骤 2 scope 加 squad 规则（三处共享自动同步：memory_manage + skill_manage + tier1 fork + tier2 prompt） |

---

## 2. 关键决策增量

| 决策 | 选择 | 理由 |
|---|---|---|
| **AppTaskLock 实现路径**（PRD 交架构决） | **新独立 `AppTaskLock` class**（不复用 SessionTaskLock 扩 sid='__app__'） | (1) 语义清晰：SessionTaskLock API 强制 `sessionId` 入参，扩 sid='__app__' 每个 caller 造/传哨兵字符串易漏、缺类型层强制；(2) **emit 目标不同**：SessionTaskLock emit `(session_panel, session_id:<sid>)` = per-sid group；AppTaskLock 需 emit 到全局广播的 app 级 topic（设置页只一个），若共用 SessionTaskLock 会产出 `group=session_id:__app__` 语义错乱事件污染 session_panel 订阅者；(3) bootstrap 装配天然分离（bus-phase 后新建 topic `app_task` + 独立单例）；(4) 未来 app 级任务可能加更多（backup/cleanup 等），独立 class 更清爽；(5) 代码复用零成本（内部 Map/CAS/emit 结构照抄 SessionTaskLock，仅移除 sessionId 维度） |
| **squad memory 存储路径**（PRD 交架构决） | **`<dataDir>/squads/<squadId>/.rocky_squad/memory.md`** | (1) 对齐既有 squad 内部约定 `.rocky_squad/`（budget-state.json、scheduler.json 都在这，见 `stores/squad-store.ts ensureSquadDirSkeleton`）；(2) 与 skill squad workspace 目录 `<dataDir>/squads/<squadId>/.rocky_squad/skills/` 心智对称；(3) 不进 `board/`/`members/`/`workspaces/` 等用户可见 squad 业务产物目录（memory 是 agent 内部记忆，非队内业务文档）；(4) `.rocky_squad/` 与 workspace 的 `.rocky/` 命名区分——避免"squad 目录当 workspace 打开"时冲突 |
| **squad skill 目录路径**（对称 memory 路径） | **`<dataDir>/squads/<squadId>/.rocky_squad/skills/`** | 与 squad memory 同处 `.rocky_squad/` 内部命名空间；skill resolver 加 squadSkillRoot() helper 与 appSkillRoot/workspaceSkillRoot 同结构；三层合并优先级 squad > workspace > app > builtin（本版本 4 层） |
| **squad memory 存储机制**（用户拍板 per-squad md） | **新建 `app/server/src/memory/squad-memory-store.ts`**（薄壁包装，复用 managed-store 内部 parseMemoryFile/serializeMemoryFile helper） | 方案 A（扩 managed-store 加 scope 参数）破坏所有既有 session API 签名；方案 C（新加 5 个 squad-scope API 在 managed-store）易增至 ~500 行超单文件上限；**方案 B 抽出薄壁独立文件**：squad-memory-store.ts 只放 squadMemoryFilePath + write/archive/list/read 5 个函数，复用 managed-store 已 `export function parseMemoryFile/serializeMemoryFile`（本次改 export）；session/squad 两 API 完全独立但共享内部 helper，无破坏性、职责最清晰、单文件 ≤200 行 |
| **SkillScope enum 扩展**（PRD 说"不改 enum"但内部实现需要区分） | 内部 `SkillScope` type 加 `'squad'` 成员（4 值 `builtin\|app\|workspace\|squad`）；**对外 skill_manage/skill 工具 input scope 不改**（仍 `global\|session\|all`，UI 零暴露） | (1) PRD "不改 enum" 是**对外 UI/工具契约**语义（用户不通过 UI 选 squad scope）；(2) **内部实现**需要 SkillScope 区分才能表达 resolver 三层扫描 + "squad > workspace > app" 优先级；(3) skill 靠**资源位置**决定 scope（放进 squad ws dir 即 squad scope），非 UI 选择 metadata，符合 skill 既有惯例（放进 workspace 即 workspace scope） |
| **L0 catalog skill 分组** | **暂不改**（squad skill 归到 workspace 组，PRD 不要求分组独立） | 用户裁决"skill UI 零改动"；skill L0 分组当前为 3 类（system/user/agent），squad skill 与 workspace skill 语义同为"用户/项目资产"，共归 user 组无语义冲突；避免过度设计 |
| **AppTaskLock SSE topic** | **新增 topic `app_task`**（广播 group `_all`，non-replayable） | (1) 对齐 session_meta 的广播 group 模式（`_all`）；(2) 事件类型 `consolidation_task_update` = 状态变更（running/done/failed/idle），设置页组件订阅一次即可；(3) 与 SessionTaskLock 的 `summary_task_update` 事件类型名区分，语义清晰；(4) 未来 app 级任务（backup 等）可复用本 topic |
| **cron + 手动触发都走 lock** | **两条触发路径都过 AppTaskLock.acquire('tier2_consolidation')** | (1) engine 既有 per-job `inFlight` Set 只防同 job 重入（同一 cron job Promise 未 settle 时 tick 跳过），**不防跨触发源撞车**（cron job 在跑 + 手动 POST 到达 = 两条独立 Promise 链，inFlight 各查各的）；(2) AppTaskLock 是唯一防"手动 POST + cron 到点"同时进入的机制，acquire 失败静默跳过（fire-and-forget，对齐 tier1 lock 惯例）；(3) 双重保护：inFlight 防同 job 重入 + lock 防同 taskType 跨调用方撞车 |
| **tier2 质量审查段判据源** | **复用 `routing_decision.md`**（不做整理专属 prompt 段） | 单一真理源——PRD 定案 2 更新的 routing 反例清单本就是「什么该记 / 什么不该记」的判据；tier2 单独维护判据 = 双份提示词、易漂移。整理 agent 的 prompt vars 加 `{{routing_rules}}` 占位符注入 ROUTING_DECISION_PROMPT |
| **无 squad 会话 scope='squad' 回退**（用户拍板 2026-07-17） | **拒绝 + 报错 `[invalid_input] not_in_squad`** | PRD 定案 1；不静默降级 global（squad 规则悄悄污染 global）、不写 orphan 分区（读不回死数据）；LLM 见错自修正（改 scope 或不写） |
| **6 类注入分组顺序**（用户拍板 2026-07-17） | **session 手 → session 自 → squad 手 → squad 自 → global 手 → global 自** | PRD 定案 1；session 最贴当前会话；squad 比 global 更贴当前任务、比 session 更稳定；global 最兜底 |

---

## 3. 与既有原则的关系

- **不改架构原则** #1~#14（memory index.md ④）+ session 原则 #1~#10——本版本是既有原则的**扩展**：
  - memory 原则 4「L0 注入 + 按需读」不变，squad mapper 同样只贡献 L0（name+intro）+ 复用 `memory` 纯读工具按需读
  - memory 原则 6「写操作原子串行化」加第三种介质分流（squad → per-file lock，同 session 惯例）
  - memory 原则 9「session memory 的 sid 由工具自动填充」的模式复用到 squad 层（squad_id 从 ctx 自动填，对齐先例）
  - memory 原则 13「四类分组 + 组内 updatedAt 倒序 + 前 N」扩到 6 类（`selectMemoriesByQuota` 纯函数升级签名，纯函数无副作用无破坏）
  - session 原则 4「SessionTaskLock CAS + 不落盘 + 内存 only」照抄到新 AppTaskLock（形态一致）
- **新增原则**（memory index.md ④ 加 #15；session index.md ④ 加 #11）——见各 KB 增量段。

---

## 4. 交付追溯

- 详细变更契约（method 级）：本目录 `change_plan.md`（planner 按行切 task，coder 按行实现，code-reviewer 按行查偏离）
- PRD：`specs/prd/version_logs/v0.0.164.memory_opt/change_log.md`（4 项定案 + 4 项用户拍板细节）
- API 契约变更：`specs/api/version_logs/v0.0.164.memory_opt/change_log.md`（POST /consolidation/run 契约详情，doc-modifier 阶段 5 一并同步 overall）
- 用户裁决记录：`states/v0.0.164/task-board.md` Check 记录段
