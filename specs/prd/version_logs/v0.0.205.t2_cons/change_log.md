# v0.0.205.t2_cons — 整理优化 + 存储模型统一（用户可感知部分） — PRD 变更日志

> 引入版本 v0.0.205.t2_cons · 2026-07-26
> 一句话：本版本在前端可见层补齐 4 项体验短板——**会话右上悬浮菜单新增 skills 入口**（3 tab 展示当前会话可见 skills，参考 skill 卡片色卡）；**T2 整理「立即整理」按钮正确反映 running 状态**（切走切回仍禁用，修 UX bug）；**T1 一级整理（compact 后）默认落 session 而非 global**（用户可感知的 memory 分布变化）；**prod global memory 全删重来**（配合底层迁移清空脏数据）。
> overall 快照：本次产出仅 version_log；overall 同步（`09-memory.md` §9.2 + `04-skill.md` §X skills 入口 + `04-config-center-ui.md` §2.3 整理状态 + `00-app-guide.md` §3.1/3.3 skills 入口路径）由 doc-modifier 在阶段 5 完成。
>
> 概念权威源（PRD 对齐，非新发明）：
> - `states/v0.0.205.t2_cons/context.md` §存储模型定稿（scope 三层 session/group/global 定稿 + .rocky/ 收口 + memory per-entry）
> - `specs/ui/components/chat-page/component-chat-float-menu.md`（聊天区右上悬浮菜单，已承载 memory + cron，本版加 skills 第 3 项）
> - `specs/ui/components/chat-page/component-memory-modal.md`（弹层二级视图模式，skills 弹层复用同模式）
> - `specs/ui/components/skill-page/component-skill-item.md`（卡片视觉基线：渐变星形 logo + name + desc + 双主题 token）
> - `specs/ui/components/app-dev-config-page/section-consolidation-config.md`（T2 整理 tab，已有 SSE `consolidation_task_update` 驱动 running/done/failed 状态机）
> - `specs/tech/agent/memory/[P0]consolidation_tier1.md` §4（T1 路由规则第二步「global vs session 默认 global」，本版改默认 session）
> - `specs/tech/agent/skills/[P0]skill_architecture.md` §4（skill resolver 四层：builtin/app/workspace/squad → 用户视角的 global/group/session 三层映射）
>
> 本质：**前端补齐 skills 入口可观测性 + 修 T2 状态 UX bug + 翻转 T1 默认 scope 贴 session + prod 数据清空。**后端存储模型统一（.rocky 收口、squad→group 改名、per-entry md、global memory 迁出 app_config、AppTaskLock 超时自愈）由 architect 在 change_plan 定，不在本 PRD 范围。

---

## 1. 背景与现状（先对齐，再改）

**问题 1 — skills 不可观测（现状）**：
- skill 子系统已落地四层合并（builtin/app/workspace/squad）+ L0 catalog 注入 system prompt（`specs/tech/agent/skills/index.md` ④），但**用户在对话中无法直接看到「当前会话能看到哪些 skills」**——只能去 nav-rail「SKILLS」全局管理页看 app/workspace 安装列表，看不到 squad 层 + 看不到当前 session 实际有效集合。
- 用户排查「agent 为什么没用某 skill」时缺第一手观测点：不知道是没装、装了但被覆盖、还是 squad 层有同名 override。
- memory 已有 chat 悬浮菜单入口（`component-chat-float-menu` 第一项）+ cron 第二项；skills 缺一个对应入口。

**问题 2 — T2 整理状态 UX bug（现状）**：
- `section-consolidation-config.md` 已有 SSE `consolidation_task_update` 驱动 `useLifecycle.onEvent` 跑 running/done/failed 状态机；但 `GET /consolidation/status` 只返 `lastRunAt` + `summary`（不返当前 task status），前端 `onInit` 写死 `isRunning=false`。
- 用户实测：点「立即整理」 → 按钮变 running → **切走 tab 再切回 → 按钮「又能点了」**（onInit 重新读 status 拿不到 running 状态）→ 用户再次点击 → 服务端 409 兜底拒绝但 UX 已坏。
- 服务端 `AppTaskLock`（v0.0.164 引入）已设 `startedAt`，但**无超时自愈**：同进程 hang 永远 running（重启天然释放=开机清理已满足，仅同进程长时间 hang 需超时接管）。

**问题 3 — T1 一级整理默认 global 导致 memory 失真（现状）**：
- `[P0]consolidation_tier1.md` §4 prompt 路由第二步：「跨项目/会话通用 → global（默认）；仅本会话 → session」。
- 实际表现：agent 几乎把所有 compact 后总结都判「跨会话通用」落 global（如「创作 squad 章节标题冲突自查 SOP」其实是 squad 内规则被误落 global），污染全局 memory 库；用户打开 global memory 看到「全是某次 squad 创作的私有规则」却看不到真正全局通用的偏好。
- `09-memory.md` §9.2.6「scope 统一命名 + 默认 global」决策历史 = 当时与 skill 对称的选择，但实际 T1 自动总结场景里默认 global 反而是误用源头。

**问题 4 — prod global memory 累积脏数据（现状）**：
- prod 用户长期使用积累的 global memory 大量是「误落 global 的 squad / session 私有内容」（见问题 3）+ v0.0.55 以来多次 schema 迁移（source/updatedAt/evolvable 等）存量补丁；用户反馈「没法看，或者全部删除了重新整理」。
- 本版存储介质从 `app_config/user_memory` record 迁出到 `<dataDir>/memory/<name>.md`（per-entry md，与 session/squad 介质同构）—— 借此切换点一次性清空旧脏数据，新介质从零开始。

---

## 2. 本版本 4 项定案（产品化表达）

### 定案 1：会话右上悬浮菜单新增 skills 入口（P0 主交付）

**用户故事**：作为对话中的用户，我希望随时点悬浮菜单看到「当前会话实际可见的 skills」分 session/group/global 三层展示，以便排查 agent 用错 skill 或验证 squad override 是否生效。

**入口与位置（对齐已有概念，非新发明）**：
- 复用 `component-chat-float-menu`（已承载 memory + cron 两个菜单项），**新增第 3 个图标菜单项「skills」**，位于「长期记忆」「定时任务」**下方**（req 明确顺序）。
- 三处 chat 页统一复用：playground 单聊 / studio 单聊 / studio 群聊 由 `component-chat-right-overlay` 承载，与 memory/cron 同模式（`specs/ui/components/chat-page/component-chat-float-menu.md` §1）。
- 视觉沿用现有悬浮工具条 token（白底圆角竖条 + 纵排图标按钮，muted → hover fg），不引入新视觉。

**弹层结构（3 tab + 卡片列表）**：
- 点 skills 菜单项 → 弹层打开（同 memory/cron 弹层模式，复用 `component-memory-modal` 的二级视图导航/遮罩点击关闭/数据 hook 恒挂载范式）。
- **3 tab**（req 明确）：
  - **session**：当前 session workspace 内 `.rocky/skills/` 加载的 skills（= skill resolver 的 workspace 层）。
  - **group**：当前 squad 或 classroom 的团队 ws 内 `.rocky/skills/` 加载的 skills（= skill resolver 的 squad 层；playground 无 group → 此 tab 空态）。
  - **global**：builtin + app 层（`<dataDir>/skills/`）= 全局继承的 skills；**「agent 从全局继承，但 member 编辑里有开关覆盖」**——本版只展示当前会话实际生效的 skills（resolver 合并后 enabled=true），**不展示被覆盖掉的下游版本**（展示「实际能用什么」而非「全部历史」）。
- tab 默认选中：session（最贴当前会话）。
- **空态**：tab 内无 skill → idle 空态（icon 圆 + muted 文案，沿用 `cron-empty` / memory empty 风格）。

**卡片呈现（参考 skill 配置样式）**：
- 复用 `component-skill-item.md` 的卡片视觉 token：**渐变星形 logo** 38×38（fixed 渐变，双主题一致）+ name 13.5px/600 + desc 12px muted-2 两行省略 + 来源徽标（builtin/app/workspace/group 四类，对应 badge sage/bg-warm token）。
- **本版只展示**（req 明确「暂时无需开关，只展示」）：不挂 enabled toggle / evolvable toggle / 预览 / 删除按钮。
- 布局：单列垂直滚动，padding/gap 与 memory 弹层 entry 列表一致（8px 12px / gap 8px）。

**数据源**：
- 复用既有 `GET /skill` 端点的 resolver 输出（四层合并后的 catalog），按 scope 分组到 3 tab；**不新增 API**（仅前端按 scope 字段分组渲染）。
- 「member 编辑里有开关覆盖」= squad layer 的 skill_state（per-squad enabled 覆盖），resolver 合并已落地（`skill_architecture.md` §4），前端只读结果。
- 数据 hook 恒挂载于 float-menu（不随弹层开关 mount/unmount），与 memory/cron 范式一致（避免弹层开关触发重 GET）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-S1 | 进入任一会话 → 看悬浮菜单 | 菜单从上到下纵排 3 个图标：长期记忆 / 定时任务 / **skills**（新增） |
| UC-S2 | 点 skills 图标 → 弹层打开 | 顶部 3 tab（session / group / global），默认选 session tab；tab 内卡片列表（name + desc + 来源徽标 + 渐变星形 logo） |
| UC-S3 | 切到 group tab（playground 单聊会话） | 空态（icon + muted 文案「无 group skills」，playground 无 squad/classroom） |
| UC-S4 | 切到 global tab | 看到全局 builtin + app 层 skills 列表（resolver 合并后实际生效的） |
| UC-S5 | studio squad 单聊会话 → 点 skills → 切 group tab | 看到 squad workspace `.rocky/skills/` 加载的 squad 专属 skills |
| UC-S6 | 弹层打开 → 点遮罩 / 顶部关闭按钮 | 弹层关闭（重开回 session tab 默认态） |
| UC-S7 | 在 SKILLS 全局页安装一个新 skill → 回会话点 skills 弹层 → 切 global tab | 看到刚装的 skill 出现（数据 hook 恒挂载，重开弹层刷新） |

### 定案 2：T2 整理「立即整理」按钮正确反映 running 状态（P0 — UX bug 修复）

**用户故事**：作为触发整理的用户，我希望切走 tab 再切回时按钮仍显示 running（禁用），不会误以为可以再次触发。

**前端行为**：
- `section-consolidation-config.tsx` 的 `onInit`/`useLifecycle` 路径：读 `GET /consolidation/status` 时**把当前 task status（running/idle/failed）一并拿到前端**，初始化 `isRunning` 不再写死 false。
- SSE `consolidation_task_update` 事件照常驱动 running → done/failed 状态迁移（既有机制不变）。
- 「立即整理」按钮在 `isRunning=true` 时禁用 + 文案「整理中...」（沿用既有 disable 视觉）。

**后端行为（架构定，PRD 只描述用户可感知结果）**：
- `GET /consolidation/status` 返回字段加 `status: 'running' | 'idle' | 'failed'` + `startedAt`（ISO，可选）。
- `AppTaskLock` 加超时自愈：acquire 时若 state=running 且 `startedAt` 距今 > 1h → 强制接管（release + re-acquire），同进程 hang 不再永久卡死；保持**内存 only 不落盘**（重启天然释放=开机清理已满足）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-C1 | 应用设置 → 整理 tab → 点「立即整理」 | 按钮立即禁用 + 文案「整理中...」 |
| UC-C2 | 整理进行中 → 切到其他 tab → 切回整理 tab | 按钮仍显示「整理中...」禁用态（onInit 读到 running 状态） |
| UC-C3 | 整理完成 → SSE 事件到 → 看按钮 | 按钮恢复可点 + 显示上次整理时间 |
| UC-C4 | 整理 hang 住 1 小时未完成 → 期间用户切回整理 tab | （下次调度时 AppTaskLock 自动接管释放）按钮恢复可点；用户不需要主动干预 |

### 定案 3：T1 一级整理默认 scope 从 global 翻转为 session（P0）

**用户故事**：作为深度使用 squad/studio 的用户，我希望 compact 后 agent 自动总结的经验默认落到当前会话私有 memory，由二级整理 + 用户人工判断再决定是否提升到 group/global，避免 squad 私有规则污染全局。

**行为变化（用户可感知）**：
- T1 compact 后 fork-2 整理 agent 写 memory 的默认 scope 从 `global` 翻转为 `session`（`memory_manage.write` 不指定 scope 时落 session 而非 global）。
- 用户在 chat 悬浮菜单「长期记忆」弹层看到的 session memory 会增多（之前都进 global）；global memory 不再混入 squad 私有规则。
- 对齐 `09-memory.md` §9.2.6 「scope 统一命名」决策需要标注 default 翻转（`[v0.0.205.t2_cons modified]`），决策 E 的 scope 命名不变、只翻转默认。

**实现落点（架构定）**：
- 改 `app/server/src/prompts/content/consolidation.md`（routing_rules）第二步：从「跨会话通用 → global（默认）；仅本会话 → session」→ 「默认 session；明确跨会话/项目通用才显式 global」。
- 对齐 `memory_manage.write` 默认值：input schema 不指定 scope 时落 session。
- **不动 `memory_manage` UI 端点的默认**（用户在 chat 悬浮菜单记忆面板手动新建时仍默认 global，保留用户对全局的显式控制权——只翻 agent 自动路径的默认）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-M1 | 真 LLM 会话 → 多轮触发 compact → fork-2 总结写 memory 不指定 scope | 落 session（`<session.workspaceDir>/.rocky/memory/<name>.md`），不入 global |
| UC-M2 | 用户在 chat 悬浮菜单记忆面板看 session tab | 看到 fork-2 总结的 entry（数量较之前多） |
| UC-M3 | 用户在应用设置「全局长期记忆」tab 看 global | 不再混入 squad 私有规则（仅含用户手动新建 + 显式指定 global 的 agent write） |
| UC-M4 | 用户在记忆编辑器手动新建 memory 不选 scope | 落 global（UI 路径默认不变，保留显式控制权） |

### 定案 4：prod global memory 全删重来（P0 — 一次性清理）

**用户故事**：作为长期使用的用户，我希望脏的 global memory 一次性清掉，新介质从零开始，未来用新的 T1 默认 session 行为重建。

**行为（用户可感知）**：
- 升级到 v0.0.205.t2_cons 后，**原 `app_config/user_memory` record 中的全部 global memory 条目不再可见**（应用设置「全局长期记忆」tab + chat 悬浮菜单记忆面板的 global tab 都空）。
- 新介质 `<dataDir>/memory/<name>.md`（per-entry md）从零开始；用户后续手动新建或 agent 自动总结（显式指定 global）会写入新介质。
- **session/group memory 不受影响**（仅清 global，session 是 per-session md 本就跟升级无关；group 是新概念本就空）。
- 用户报志愿确认（req 第 4 块「整理一下现在 prod 环境的 memories，没法看，或者全部删除了重新整理」——选了「全部删除」路线）。

**实现落点（架构定）**：
- 不做 migration（不把 `app_config/user_memory` record 迁移到新 md 介质）——一次性丢弃旧 record；旧 record 物理保留在 `app_config` 落盘文件中（用户回滚版本可手动恢复），但新版本读不到。
- 新 `UserMemoryService` 从 `<dataDir>/memory/<name>.md` 目录扫描加载（与其他 scope 同构）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-P1 | 升级前 prod global memory 有 N 条 → 升级到 v0.0.205.t2_cons → 打开应用设置「全局长期记忆」tab | 空态（idle icon + muted 文案） |
| UC-P2 | 升级后用户在「全局长期记忆」tab 点「新建」→ 写一条 → 保存 | 落 `<dataDir>/memory/<name>.md`，列表显示新条目 |
| UC-P3 | 升级后 chat 悬浮菜单记忆面板 → 看 global tab | 空（与全局页一致） |

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| 路径 A | 打开会话 → 悬浮菜单看到 skills 入口（第 3 项）→ 点击 → 弹层 3 tab（session/group/global）+ 卡片列表正常展示 | skills 入口可用，3 tab 分组正确，卡片渲染 name+desc+色卡 | E2E |
| 路径 B | playground 会话 → skills 弹层 → 切 group tab | 空态（playground 无 group） | E2E |
| 路径 C | studio squad 会话 → skills 弹层 → 切 group tab → 看到 squad workspace 加载的 skills | group tab 数据正确 | E2E |
| 路径 D | 应用设置 → 整理 tab → 点立即整理 → 切走 tab → 切回 → 按钮仍禁用「整理中...」 | onInit 读到 running 状态，UX 修复 | E2E |
| 路径 E | 真 LLM 触发 compact → fork-2 写 memory 不指定 scope | 落 session（`<session.workspaceDir>/.rocky/memory/`），不入 global | AT（真 LLM） |
| 路径 F | 升级后首次启动 → 应用设置「全局长期记忆」tab | 空态（旧 app_config record 不再可见） | UT（确定性边界，无需 AT） |
| 路径 G | 升级后 chat 悬浮菜单记忆面板 global tab | 空态（同路径 F） | UT |

**路径数**：7 条（A-G）。
- AT 真调 LLM：路径 E（compact 时机行为不确定 + LLM 参与）。
- ET（agent 玩 app）：路径 A/B/C（skills 入口 UI 主交付）+ 路径 D（整理按钮 UX 修复）。
- UT 覆盖：路径 F/G（确定性状态判定，不进 AT）。
- 不入 AT/ET：session scope 路径 E 的存储位置（依赖存储模型统一架构，由 UT 守底层契约）。

---

## 4. 范围边界（IN / OUT）

### IN（用户可感知，本 PRD 范围）

1. 会话右上悬浮菜单加 skills 第 3 菜单项 + 弹层 3 tab + 卡片（只展示无开关）。
2. T2 整理 tab「立即整理」按钮反映 running 状态（onInit 读 status + SSE 驱动）。
3. T1 一级整理（compact 后 fork-2）默认 scope 翻转为 session（agent 路径；UI 路径不变仍默认 global）。
4. prod global memory 一次性清空（不做 migration，新介质 `<dataDir>/memory/<name>.md` 从零）。

### OUT（架构处理，不进 PRD）

- 存储模型统一重构：`.rocky/` 收口 / scope squad→group 改名 / memory per-entry md 模型 / global memory 迁出 app_config / `.rocky_squad → .rocky` 改名 / classroom 新增 group 层 / session ws 可变复制 `.rocky`。
- AppTaskLock 超时机制实现（startedAt > 1h 接管）。
- T2 调度内部超时保护 / 三段串行调度细节。
- skill resolver 四层加载机制实现（builtin/app/workspace/squad 合并）。
- 文件系统布局 / 路径约定 / migration 脚本 / 启动初始化顺序。
- session memory 介质从 `sessions/<sid>/session_memory.md` 迁到 `session.workspaceDir/.rocky/memory/`（用户不可感知，仅底层路径变）。
- `memory_manage` / `skill_manage` 工具 schema 字段语义不变（工具契约稳定）。

---

## 5. 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| skills 弹层入口位置 | 复用 `component-chat-float-menu` 加第 3 项 | 与 memory/cron 对称，三处 chat root 统一复用既有 overlay 容器，无新概念 |
| skills 弹层 3 tab 命名 | session / group / global | 对齐 `states/v0.0.205.t2_cons/context.md` 存储模型定稿 scope 三层；用户视角而非实现 enum（squad→group 是底层改名，对外统一 group） |
| skills 卡片只展示无开关 | 暂不挂 enabled/evolvable toggle | req 明确「暂时无需开关」；展示优先，开关留下版本（避免与 SKILLS 全局管理页职责重叠） |
| T1 默认 scope 翻转只翻 agent 路径 | UI 手动新建仍默认 global | 用户对自己手动新建的资产保留显式全局控制；只修 agent 自动路径的误判 |
| prod global memory 全删不迁 | 一次性丢弃 + 新介质从零 | req 第 4 块用户明确「全部删除」；旧 record 物理保留可回滚；migration 价值低（数据多为脏） |
| 整理按钮状态修复走 status 端点 + AppTaskLock 超时 | 双管：前端 onInit 读 status + 后端超时接管 | 前端修复切走切回 UX；后端超时解决 hang 永久卡死；重启天然释放已满足（仅同进程 hang 需超时） |

---

## 6. overall 同步待办（doc-modifier 阶段 5 处理）

| overall 文件 | 同步内容 |
|---|---|
| `specs/ui/overall/00-app-guide.md` | §3.1 Playground 操作路径补「悬浮菜单 skills 入口」（与 memory/cron 并列）；§3.3 SKILLS 全局页与 chat 悬浮菜单 skills 入口的关系说明（前者管理 / 后者观测当前会话生效集合） |
| `specs/ui/overall/03-config-center.md` | §2.3 consolidation group 补「立即整理按钮反映 running 状态」+ onInit 读 status + AppTaskLock 超时自愈的 UX 语义（不写实现） |
| `specs/ui/overall/04-skill-page.md` | 新增章节「chat 悬浮菜单 skills 入口」（区别于全局 SKILLS 管理页：只读 + 当前会话可见 + 3 tab 分组） |
| `specs/prd/overall/09-memory.md` | §9.2.6 「scope 统一命名 + 默认 global」加 `[v0.0.205.t2_cons modified]` 标注：T1 compact 后 agent 路径默认翻转为 session（UI 路径仍默认 global 不变）；§9.2 注释 prod global memory 一次性清空节点 |
| `specs/prd/overall/04-config-center-ui.md` | 整理 tab 行为补「立即整理」running 状态正确反映（与 03-config-center UI 契约一致） |

---

version: 0.0.205.t2_cons（v0.0.205.t2_cons 引入；用户可感知层 = skills 入口 UI + T2 状态 UX 修复 + T1 默认 scope 翻转 + prod global memory 清空。底层存储模型统一重构走架构 change_plan，不进 PRD）
