# v0.0.33.1 PRD 变更日志 — Squad CRUD + Studio 管理 UI（对话全占位）

## 概述

本版本交付 **squad 团队/角色 CRUD + Studio 管理 UI**：把 squad 层「数据 + 存储 + 管理」骨架一次性立起来，团队管理操作（建 squad / hire / bench / deploy / edit member / charter 编辑）后端 + UI **全实跑**；agent loop **完全不接**，所有 chat 入口点击进入占位页（banner「该角色对话能力在 v0.0.33.2 上线」，不调 LLM、不报错）。

**一句话定位**：用户在 Studio 里走完「建 squad → hire member → bench/edit member → 编辑 charter」全流程；对话占位不报错；squad 相关 session 不污染 Playground 列表。

**父版本**：v0.0.33（squad 启动）；**地基依赖**：v0.0.28（multi_agent）+ v0.0.31（a2a / deliverTo）。

技术 / 存储细节（SchemaDef、双向关联、存储布局、建队事务、补偿回滚）由 architect 落 `specs/tech/squad/`，本 PRD 只描述诉求 + 引用已有概念。

权威输入：`reqs/v0.0.33.1/req.md` + `reqs/v0.0.33.1/design-brief.md`；系统设计：`states/v0.0.33.1/design.md`（实体 + API + 流程）；视觉契约：6 个 html 设计稿 + `reqs/v0.0.33.1/design-brief.md` §2 token。概念对齐见 §5。

---

## 1. 用户验收标准

用户能在 **Studio** 里走完以下管理全流程，对话入口占位不阻塞：

1. **建 squad**：填 wizard（name + leader name + leader systemPrompt + modelDefault，charter 4 字段可空）→ 提交后看到 squad 卡片；展开树看到 1 个 leader + 1 个群聊（chat 入口占位）。
2. **hire 3 个 member**（fresh + derive 各至少一次）→ 列表出现新 member + 各自展开有 mate session。
3. **bench 一个 member**（填 reason）→ 状态转 benched，用户收到通知；**deploy** 恢复 deployed。
4. **edit 一个 member**（角色面板改姓名/介绍/systemPrompt/tools）→ 右下悬浮保存生效。
5. **编辑 charter**（管理 tab 4 字段 PUT）→ charter_history 留痕，可查历史。
6. **占位 chat**：点群聊/leader/member 任一 → 进占位页，banner 正确，不报错。
7. **Playground 隔离**：切到 Playground tab，列表看不到任何 squad session。
8. **nav-rail 改造**：Playground / Studio 顶部入口；设置组底部齿轮向上展开；无 theme-toggle。

---

## 2. 设计原则（用户拍板 + design.md 锁定）

1. **squad 是团队信息权威源**：member / role / sessionId 靠 squad 双向同步；管理操作全走 HTTP + UI（本版本不做对话驱动）。
2. **数据字段一次到位**：v2/v3/v4 字段位（charter / heartbeat / budget / enableHeartBeat）v1 就有（存但不生效），避免后续 migration。
3. **对话全占位**：session.type 字段持久化（squad/leader/mate）但**不跑 agent loop**；POST messages 对 studio session 返 `403 studio_chat_not_ready`。
4. **squad / member 不可删，leader 不可 bench**：API 两层都拒（squad 无 DELETE 端点；leader bench 返 403；member 用 bench 兜底，无 fire）。**推翻 req.md 旧版 `DELETE /squad → _archived`**。
5. **bizType 隔离**：squad/leader/mate session 显式 `bizType=studio`；现存 session lazy 默认 playground；GET /session 缺省按 playground 过滤。
6. **命名 B 方案**：`member` entity（含 leader+mate，role 字段区分）+ `session.type = 'squad'|'leader'|'mate'|'subagent'`。

---

## 3. 功能范围

### 3.1 IN SCOPE

| 编号 | 功能 | 描述 | 优先级 | 权威概念 spec |
|---|---|---|---|---|
| **A** | **建 squad**（wizard + 事务） | POST /squad → createSquadService：建 squad record（charter embedded）+ leader member + leader session + 群聊 session + 目录骨架（board/outputs/reports/workspaces/members/charter_history/.rocky_squad/state），含补偿回滚。详见 design.md §1/§3.1/§4。 | P0 | data_model §1.1/§4；squad_definition §2 |
| **B** | **hire member**（fresh + derive） | POST /squad/:id/member：fresh（填新字段）或 derive（deriveFrom + inheritMemory + overrides）→ 建 member（role=mate）+ mate session + workspace + 回填双向 + append memberIds。详见 design.md §3.2 + data_model §5。 | P0 | data_model §1.2/§5；squad_definition §3/§4 |
| **C** | **bench / deploy member** | POST /squad/:id/member/:mid/bench（body `{reason}` → benched + 通知 user）+ /deploy（恢复 deployed）。**leader 不可 bench，返 403**。详见 design.md §3.2。 | P0 | squad_definition §3/§8（leader 永远 deployed） |
| **D** | **edit member**（角色面板） | PATCH /squad/:id/member/:mid：姓名介绍 / systemPrompt / tools / skills / model 实跑；当前任务 / 记忆管理占位（banner）；右下悬浮保存。详见 design.md §3.2 + 06-studio §4。 | P0 | squad_definition §3；data_model §1.2 |
| **E** | **charter 编辑 + history** | GET / PUT / GET history 三端点（design.md §3.3）。PUT 是 partial patch（4 字段 goals/workingStyle/collaboration/escalation），每次写一条 charter_history（append-only）。详见 design.md §3.3 + data_model §1.3。 | P0 | squad_definition §5；data_model §1.3 |
| **F** | **Squad 面板（4 tab）** | 介绍（实跑：description + charter 摘要）/ 目标（占位 v0.0.33.3）/ 成员（实跑：列表 + hire + bench/deploy/edit）/ 管理（实跑：squad 元信息 + charter 编辑器 + history + budget/enableHeartBeat 占位）。详见 06-studio §3。 | P0 | 06-studio §3 |
| **G** | **占位 chat** | 点群聊/leader/member/subagent → 占位 banner「该角色对话能力在 v0.0.33.2 上线」；POST /session/:id/messages 对 studio session 返 403 `studio_chat_not_ready`；GET messages 可读。详见 design.md §3.4 + 06-studio §5。 | P0 | squad_definition §7；session_biztype §1 |
| **H** | **bizType 隔离** | session.bizType 字段（playground|studio，optional 空=playground）；GET /session?bizType=playground 缺省过滤；studio session 显式 studio；subagent 跟 parent；现存 lazy 默认。详见 design.md §1.3 + session_biztype 全文。 | P0 | session_biztype §1-§4 |
| **I** | **nav-rail 改造** | 顶部业务区 Playground（原 chat 改名）+ Studio；底部设置组折叠（齿轮收纳 5 项，点击从下向上展开）；删 theme-toggle；brand「R」置顶不变。详见 nav-rail.md。 | P0 | nav-rail.md（[v0.0.33.1] 改造段） |
| **J** | **squad 列表 + 展开树** | GET /squad 列表；studio-sidebar 卡片视图 + 顶部「新建 squad」按钮；展开树显示该 squad 下所有 chat session（群聊 + leader + mates + 各自 subagents），点节点进占位 chat。详见 06-studio §2。 | P0 | 06-studio §2 |

### 3.2 OUT OF SCOPE（NON-GOALS — 显式不做）

| 排除项 | 承接版本 | 理由 |
|---|---|---|
| **任何 LLM 调用 / agent loop 启动** | v0.0.33.2 | 本版本只立管理骨架 |
| **chat 真实跑**（接 LLM / `<EOS>` / prompt builder） | v0.0.33.2 | 占位 banner 兜底 |
| **工作项**（goal / requirement / task store + 工具） | v0.0.33.3 | 看板 OKR 实体留 v3 |
| **看板 UI 内容** | v0.0.33.3 | 仅 tab 占位 banner |
| **心跳 / scheduler / budget gate / enableHeartBeat 实跑** | v0.0.33.4 | 字段占位，scheduler 留 v4 |
| **leader 对话驱动 update_charter** | v0.0.33.3 | 本版 charter 只由 user 在 UI/API 管 |
| **LLM 工具 team / task** | v0.0.33.3 | 本版管理全走 HTTP + UI |
| **DELETE squad / fire member** | 不做 | squad 不可删；member bench 兜底（design.md §1.1 锁定） |
| **bench 通知 user 的复杂 UI 形态**（toast / 系统消息卡等） | 留待细化 | 本版先有数据层 + 最小可见反馈，复杂形态后定 |
| **charter PUT 乐观锁 / hire derive overrides 精确字段集** | 架构细化 | design.md §6 待定，非阻塞 |
| **subagent 迁移到新统一框架** | v0.0.33.2 | 本版仅命名同步 |

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径 = 后续至少一个 API / E2E case。所有命名 / 接口语义对齐 design.md + 概念 spec（见 §5）。

### 路径 1：建 squad（wizard 事务）
用户在 studio-sidebar 点「新建 squad」→ wizard 填 name / description? / modelDefault / leader.name / leader.systemPrompt / charter?（4 字段可空）→ 提交 POST /squad → createSquadService 事务建 squad + leader member + leader session + 群聊 session + 目录骨架 → 跳转 squad 面板，sidebar 出现新卡片，展开见 leader + 群聊节点。
**断言**：squad record 存在；memberIds=[leaderId]；leader.sessionId ↔ session.memberId 双向；session.squadId 填；群聊 session.type=squad bizType=studio；目录骨架全建。

### 路径 2：hire member（fresh + derive）
squad 面板 → 成员 tab → 「新增成员」→ hire 表单切换 fresh / derive → fresh 填 name/systemPrompt/tools/skills/model；derive 选 deriveFrom + inheritMemory + overrides → 提交 POST /squad/:id/member → createMemberService → member 出现在列表 + 展开有 mate session。
**断言**：mate member（role=mate, state=deployed）；squad 内 name 唯一；mate session.type=mate bizType=studio memberId 双向；workspace 目录建；squad.memberIds append；derive 模式 inheritMemory=true 时复制父 member 长期记忆。

### 路径 3：bench / deploy member（leader 不可 bench）
成员 tab → 点 mate 行 bench → 填 reason → POST /squad/:id/member/:mid/bench → state=benched + benchReason/benchedAt 填 + 通知 user。benched 行点 deploy → POST .../deploy → state=deployed。
**断言**：mate state 状态机 deployed⇌benched；通知 user 有数据层落地；**对 leader 调 bench 返 403**（leader 永远 deployed，design.md §3.2 / squad_definition §8）。

### 路径 4：edit member（角色面板）
单聊 session（leader/mate）内点头像 → 进 member 面板（占用会话区域，路由切换 + 左上回退）→ 4 section：姓名介绍（实跑）/ 当前任务（占位 v0.0.33.3）/ 记忆管理（占位）/ 工具管理（实跑）→ 改字段后右下悬浮保存 → PATCH /squad/:id/member/:mid。
**断言**：PATCH 生效；占位 section banner 可见不报错；回退返回对话。

### 路径 5：charter 编辑 + history
squad 面板 → 管理 tab → charter 编辑器改 4 字段子集 → 填 reason → PUT /squad/:id/charter（partial patch）→ 写一条 charter_history（patch + reason + triggeredByMessageId 空）→ GET /squad/:id/charter/history 看到倒序列表。
**断言**：charter embedded in squad record 更新；history append-only；reason 必填。

### 路径 6：占位 chat
studio-sidebar 树点群聊 / leader / mate / subagent 任一节点 → 进正常 chat 路由 → 占位 banner「该角色对话能力在 v0.0.33.2 上线」+ 描述。
**断言**：不进 agent loop / 不调 LLM / 不报错；**POST /session/:id/messages 对 studio session 返 403 `studio_chat_not_ready`**；GET /session/:id/messages 可读（端点可用）。

### 路径 7：Playground 隔离
建完 squad 后切 Playground tab → GET /session?bizType=playground（缺省）→ 列表不含任何 squad session（群聊/leader/mate/studio subagent）。
**断言**：squad/leader/mate session bizType=studio；现存 session lazy 默认 playground；Playground 列表干净。

### 路径 8：nav-rail 改造
点 nav-rail 顶部 Playground（原 chat 改名）/ Studio 切换 view → 底部齿轮（nav-settings-group）点击 → 子菜单从底部向上展开 5 项（用户/插件/系统/Skill/连接器）→ 点子项切换 view + 自动收起。
**断言**：无 theme-toggle；brand「R」置顶不可点；激活态左竖条不位移；子菜单展开方向向上。

---

## 5. 与概念 spec / design.md 对齐确认（MANDATORY）

PRD 引用的所有组件 / 布局 / 数据概念 / 接口语义均与已有概念 spec 一致，**无冲突**：

| 概念 | PRD 用法 | 权威 spec | 对齐 |
|---|---|---|---|
| `member` entity（含 leader+mate，role 区分） | 建队建 leader，hire 建 mate | data_model §1.2 + squad_definition §3 | ✅ |
| `session.type = 'squad'\|'leader'\|'mate'\|'subagent'` | 群聊/leader/mate session 显式 type | squad_definition §7 + design.md §5 命名清单 | ✅ |
| `session.bizType = 'playground'\|'studio'`（optional 空=playground） | studio session 显式 studio；GET 缺省 playground | session_biztype §1-§4 + data_model §1.4 | ✅ |
| squad 不可删 / member 不可删 / leader 不可 bench | 无 DELETE 端点；bench 兜底；leader bench 返 403 | design.md §1.1 + squad_definition §8 | ✅ |
| charter embedded in squad record（4 定性字段，不关联 member） | PUT /squad/:id/charter 改 4 字段 | squad_definition §5 + data_model §1.1 | ✅ |
| charter_history（append-only，partial patch + reason） | PUT 写一条 + GET history | data_model §1.3 + squad_definition §5 | ✅ |
| createSquadService 8 步事务 + 补偿回滚 | 路径 1 建队事务 | data_model §4 + design.md §4 | ✅ |
| createMemberService（fresh / derive） | 路径 2 hire | data_model §5 + squad_definition §4 | ✅ |
| 占位 chat 403 `studio_chat_not_ready` | 路径 6 POST messages 返 403 | design.md §3.4 + 06-studio §5 | ✅ |
| Studio view（4-tab + member 面板 + 占位 chat + testid） | 路径 1/4/6/8 UI 契约 | 06-studio 全文 | ✅ |
| nav-rail 改造（Playground/Studio 顶部 + 设置组折叠 + 去 theme） | 路径 8 | nav-rail.md（[v0.0.33.1] 段） | ✅ |
| `enableHeartBeat`（默认 false，替代旧 autonomyEnabled）+ budget 占位 | 管理 tab 占位 disabled | squad_definition §2/§8 + design.md §1.1 | ✅ |
| 双向关联三组（squad⇄member / member⇄session / session⇄squad） | 建队/hire 回填 | data_model §2 | ✅ |

**PRD 无发明概念**：所有命名（member/leader/mate/bizType/charter/charter_history/enableHeartBeat）、接口（POST /squad + member 管理 + charter 三端点 + GET /session?bizType）、状态机（deployed⇌benched）、403 语义均来自概念 spec / design.md，PRD 仅做产品化表达。

**与 design.md 差异说明**：req.md 旧版有 `DELETE /squad → _archived` + `autonomyEnabled` + `type=leader|member`，**design.md 已推翻**（squad 不可删 / enableHeartBeat 替代 / role=leader|mate）。本 PRD **完全跟随 design.md 锁定版**，不回滚。

---

## 6. 数据 / API 概述（引用，不重复抄）

- **实体 4 个**（详见 design.md §1 + data_model §1）：`squad`（file engine 不分片 不可删）/ `member`（file engine 按 squadId 分片）/ `charter_history`（file engine 按 squadId 分片 append-only）/ `session`（现有 + 增量字段 bizType/squadId/memberId）。
- **API 端点**（详见 design.md §3）：
  - Squad CRUD：POST/GET/GET/:id/PATCH /squad（**无 DELETE**）。
  - Member 管理（squad 内）：POST /squad/:id/member（hire）/ PATCH .../member/:mid（edit）/ POST .../member/:mid/deploy / POST .../member/:mid/bench（leader 返 403）。**无 DELETE member**。
  - Charter：GET/PUT/GET history 三端点（PUT 写 charter_history 一条）。
  - Session（复用现有 + bizType）：GET /session?bizType=... / GET /session/:id / GET /session/:id/messages（可读）/ POST /session/:id/messages（studio session 返 403 `studio_chat_not_ready`）。
- **建队事务 + 补偿回滚**：详见 design.md §4 / data_model §4。
- **存储布局**（`data_dir/squads/{squadId}/{squad.json, members/, charter_history/, board/, outputs/, reports/, workspaces/, .rocky_squad/state/}`）：详见 design.md §2 / data_model §3。

---

## 7. 后续版本承接（不在本版本范围）

| 版本 | 承接 |
|---|---|
| **v0.0.33.2** | 对话接通：agent loop 启动 / chat 真实跑 / SquadChat `<EOS>` / prompt builder / member 记忆管理（部分） |
| **v0.0.33.3** | 工作项 + charter 对话演化：goal/requirement/task store + 看板 UI + leader 对话驱动 `update_charter` 工具 + LLM team/task 工具 |
| **v0.0.33.4** | 心跳 + budget：enableHeartBeat scheduler 实跑 / budget gate / 心跳 window + interval / squad_meta SSE（多 member 变化） |

---

## 8. 风险点 / 设计注意

- **数据字段一次到位**：v2/v3/v4 字段（charter / heartbeat / budget / enableHeartBeat）v1 必须有占位，否则后续 schema migration 成本高（design.md §1 + req.md §6）。
- **目录骨架一次建对**：board/outputs/reports 子目录建队即建（空），v3 才真写，避免 v3 补建逻辑（design.md §2）。
- **bizType 三处必须都覆盖**：session 字段 + GET /session 过滤 + UI 路由分离，任一漏则 Playground 列表被污染（session_biztype §1）。
- **leader 不可 bench 双层拒**：API 返 403 + UI 隐藏按钮（design.md §3.2 + squad_definition §8）。
- **charter_history append-only 并发**：写并发用追加而非整体重写（data_model §1.3）。
- **视觉契约 = 验收门槛**：本版本带 6 个 html 设计稿（视觉权威源），coder 实现前按设计稿填组件 spec「视觉基线」字段；验证须跑 `vision_check.py compare` 逐维度比对（layout/font/border/color）。
- **占位 section 也要可见美观**：member 面板的占位 banner 不让用户以为坏了（req.md §6）。

---

## 10. Known-Issue（合并门槛放松，用户确认带 known-issue 合并）

### BUG-004 — Studio 视觉保真系统偏差（5/6 FAIL）

- **状态**：open · **类型**：视觉保真（Major，合并门禁项）
- **发现于**：v0.0.33.1 E2E round-2 视觉保真 compare（`states/v0.0.33.1/verify/e2e-test/round-2/compare_result.json`）
- **明细**：6 个设计稿 compare，仅 `new-squad` PASS 4/4，其余 5 FAIL：
  - charter-editor FAIL 1/4（font/border/color: accent）
  - chat-placeholder FAIL 1/4（layout: 多 256px 侧栏）
  - hire-member FAIL 0/4（layout: 缺 Description + font + border + color）
  - role-panel FAIL 1/4（layout: 多侧栏 + font + border: dashed）
  - studio-main FAIL 1/5（layout: nav-rail 宽/折叠态）

**两类偏差**：
- **A 类（真 impl 视觉偏差，待后续版本修）**：① accent 色偏粉橙（impl ~`#e8a48a` vs 设计 `#d97757` terracotta，系统性多处）；② role-panel section border impl `2px dashed`（设计实线 + 大圆角）；③ charter-editor font/圆角（label 非 mono/非大写，textarea 圆角偏小）；④ hire-member chip 形状（impl pill vs 设计直角 chip）。
- **B 类（需产品裁决，非纯 impl bug）**：⑤ chat-placeholder/role-panel compare 口径——设计稿画局部组件，impl 是整页（多 256px squad 侧栏），compare 应截局部还是设计稿画整页？⑥ hire-member 缺 DESCRIPTION 字段——设计稿 hire 表单有 Description，但 `specs/ui/components/studio-page/hire-member-form.md` 字段集无（fresh = name/systemPrompt/tools/skills/model）。设计稿权威还是 spec 权威？

**功能层不受影响**：API 7/7 PASS + e2e DOM 全绿（功能 work）。本 BUG 纯视觉保真。

**处置**：用户确认 known-issue 合并，待后续版本修。BUG 详情 + 处置建议见 `states/v0.0.33.1/bugs/BUG-004-studio-视觉保真系统偏差-[open].md`。技术侧无变更（视觉偏差不涉及 tech/api spec），tech version_log 不重复记录。

---

## 11. 文档同步（doc-modifier 阶段 5 落地）

- **新增** `specs/prd/overall/08-squad-studio.md`：squad + Studio 全量 PRD（定位/功能/路径/范围/决策/验收 + BUG-004 known-issue）。
- **API spec 笔误修正**（`specs/api/overall/11a-squad-endpoints.md`）：
  - §2.1 member name 冲突错误码 `400` → `409 member_name_conflict`（409 Conflict 语义正确，对齐 §6 错误码汇总 + 实现 + AT case）
  - §2.2 PATCH 响应 shape `200 + Member` → `200 + { member: Member }`（与 §2.1 hire / §2.3 deploy / §2.4 bench wrap 一致，对齐实现+AT）
- **MemberEntity 无 description 字段** 已记录：Member 面板"介绍"= systemPrompt（`specs/ui/components/studio-page/member-panel.md` + 06-studio §4.1）。
- **hire-fresh-systemprompt/model + bench-modal testid + spec** 已由 coder 编码阶段补齐（核对：`specs/ui/components/studio-page/hire-member-form.md` testid 行 + `bench-modal.md` 完整）。

---

## 9. 版本

v0.0.33.1 — squad 团队/角色 CRUD + Studio 管理 UI 首版（管理全实跑 + 对话全占位）。基于 `reqs/v0.0.33.1/req.md` + `design-brief.md` + `states/v0.0.33.1/design.md` + 概念 spec（data_model / squad_definition / session_biztype / 06-studio / nav-rail）。命名体系 B 方案锁定（member entity + role=leader|mate + session.type member→mate）。
