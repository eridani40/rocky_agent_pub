# v0.0.55 PRD Change Log — memory UI 可见 + skill governance + 统一 session 锁 + squad workspace

> version: 1.0 · 2026-07-03
> 一句话定位：把 v0.0.51 落地的长期记忆机制从「agent 黑盒」补成「用户可见可控」，并修一批关联 gap——skill 治理 UI、exclusive EP 字段脱节 bug、统一 per-session × per-task 锁、squad leader/mate 右侧区域。
> 概念权威源（PRD 必须对齐）：
> - memory：`specs/tech/agent/memory/`（memory_definition §2 user/session scope / memory_manage_tool §7 文件锁 / consolidation_tier1 §时机B fork-2）
> - skill 治理：`specs/tech/agent/skills/skill_definition §6/§8` + `skill_manage_tool`（**本版本要改：删 mutableLocked + 改 mutable→evolvable**）
> - context exclusive EP：`specs/tech/agent/context/context_compact_detail §2c/§2d`（should/do compact + post-compact EP）
> - 插件 exclusive：`specs/tech/config/plugin_config_service §2/§4.2` + `ext_impl_scope`（**本版本要改：废弃 `exclusive` 字段**）
> - squad：`specs/ui/components/studio-page/_overview.md`（member-panel/squad-chat-page）
> - chat workspace：`specs/ui/components/chat-page/component-workspace-panel.md`（右侧 ws-panel 现仅「工作区」tab）
> - 应用设置：`specs/ui/components/app-dev-config-page/page-app-settings-merged.md`（group sidebar 结构）
> 设计稿：`reqs/[working] v0.0.55.memory_ui_session_lock/design/ui-demo.html`（4 场景：会话右侧 session memory tab / 应用设置全局 memory / nav skill 治理 / studio workspace）→ 视觉保真度门禁**用户自做 E2E 验证**。

---

## 1. 版本目标

把 v0.0.51 长期记忆机制的「用户侧」补完，同时清理一批关联 bug/gap。5 个需求互相独立但共享「用户对自我演化的可见可控」主题：

1. **长期记忆用户侧可见**（按 scope 分两处）：session 级在会话右侧「长期记忆」tab；user 级在应用设置「全局长期记忆」入口。
2. **skill governance UI + 字段改名**：复用 nav skill 列表加双开关（启用 / 自进化）；`mutable → evolvable`、删 `mutableLocked`（v0.0.51 刚引入、零历史包袱）。
3. **统一 in-memory per-session × per-task 锁**：取代 v0.0.54 的 `summaryTask` 特定保护，覆盖 compaction + tier1 整理 + 后续同类任务。
4. **squad workspace + 右侧区域**：leader/mate/squad chat 加右侧 tab 区域（workspace + 长期记忆）。
5. **exclusive EP 机制统一（enabled+order，修 bug）**：废弃 `exclusive` 字段，前后端字段脱节致 UI 多红框 / radio 一个 dot / 切不生效。

---

## 2. 核心功能（引用 tech spec，一句话各）

### 2.1 长期记忆 — session 级（会话右侧「长期记忆」tab）[v0.0.55]
**描述**：在 playground chat / studio leader / mate / squad chat 右侧 tab 区域，workspace tab 旁新增「长期记忆」tab，列出当前 session 的 `session_memory.md` 全部 entry，支持查看/编辑/归档/删除/新建。
**权威概念**：`memory_definition §2` session_memory scope（session 级工作上下文，随 session）。
**接口路径（与 agent 正交，MANDATORY）**：不复用 `memory_manage` 工具（那是 agent 的）；走 **UI 专用 HTTP 端点**——GET 列表 / POST 新建 / PATCH 更新 / DELETE 归档。具体端点契约 architect 落 `specs/api/`。
**视觉**：右侧 ws-panel 内多 tab 切换（「工作区」+「长期记忆」）；列表项展示 name/type/description/body/why/how-to-apply；新建走弹层。testid 命名 `memory-session-*`（architect 落 `specs/ui/components/`）。

### 2.2 长期记忆 — user 级（应用设置「全局长期记忆」）[v0.0.55]
**描述**：在 nav → 应用设置（`page-app-settings-merged`）的 group sidebar 新增「全局长期记忆」group，列出 `user_memory.md` 全部 entry（跨 session 稳定的用户偏好/事实/反馈教训/外部参考）。
**权威概念**：`memory_definition §2` user_memory scope（跨 session 共享）。
**接口路径**：同 §2.1 走 UI 专用 HTTP 端点（区别仅 scope=user）。
**视觉**：复用 `SectionConfigLayout` group 结构，选中后右栏渲染 entry 列表 + 编辑（与 §2.1 entry 编辑控件复用）；testid 命名 `memory-user-*`。

### 2.3 skill governance UI（nav skill 列表双开关）[v0.0.55]
**描述**：复用 `nav-rail → skill-page` 现有 skill 列表（不另做 panel），每个 `component-skill-item` 加**两开关**：**启用**(enabled，复用现有 toggle) + **自进化**(evolvable，新增 toggle)；同步删 status badge 中与 evolvable 相关的冗余文案。
**字段改名（SPEC CHANGE，零历史包袱）**：`mutable → evolvable`（更直观「是否开启自进化」；v0.0.51 刚引入、尚未被消费）。
**删 `mutableLocked` 维度（SPEC CHANGE）**：UI 一定能改 evolvable；agent 不碰 evolvable 元字段（它不会无聊改这个）。用户要禁某 skill 自进化 → UI 直接把 evolvable 设 false（无需 lock）。
**接口**：
- `PATCH /skill/:name/governance` 简化为只改 evolvable（删 mutableLocked 强制，`app/server/src/skills/governance.ts`）。
- `skill_manage.patch` 禁改 evolvable（agent 不碰治理元字段）。
**视觉**：skill-item controls 加第二个 toggle（`skill-item-{id}-evolvable`）；布局稳定性遵循——按钮空间预留，hover 不导致位移。

### 2.4 统一 in-memory per-session × per-task 锁 [v0.0.55]
**描述（产品行为）**：同一 session 同类后台任务（compaction / tier1 整理 / 后续同类）**同时只一个在跑**——冲突直接跳过（fire-and-forget 不堆积，不排队）；应用挂了内存自然清空，无幽灵锁。
**核心约束（产品层）**：
- 内存里，**不落盘**——客户端产品，磁盘锁会被认为有问题；内存锁简单有效，重启自然清空。
- 统一抽象——`acquire(sessionId, taskType) → bool` / `release` / `getState`；不同 session × 不同 taskType 互不阻塞。
- compaction + tier1 整理都接入；**取代 v0.0.54 的 `summaryTask` 特定保护**（v0.0.55 通用机制 subsumes summaryTask CAS）。
**技术实现**：标注「**architect 细化**」——内存锁抽象（per-session Map<taskType, state>）+ acquire/release CAS 语义 + 接入到 compact/tier1 触发点。需先落 `specs/tech/` 概念（agent/session 或新 KB）再编码。
**API（产品行为）**：`POST /session/:id/compact` 在锁占用时仍返 409 `compact_in_progress`（保持 v0.0.54 行为）；tier1 同模式（如可观测）。

### 2.5 squad workspace + 右侧区域 [v0.0.55]
**描述**：studio squad leader/mate/squad chat 现无右侧区域，新增右侧 tab 区域。
**workspace tab 语义（区分团队/个人）**：
| 场景 | workspace 语义 |
|---|---|
| studio leader | 团队工作区 |
| studio mate | 个人工作区 |
| squad chat（群聊） | 团队工作区（**新加**） |
| playground session | 个人（现有不变） |
**右侧 tab 区域**（leader/mate）：workspace tab（复用 `component-workspace-panel` 文件树）+ 长期记忆 tab（§2.1）。
**视觉**：与 playground ws-panel 同结构（可收起 / 可拖宽 / tab / 内容区）；testid 命名 `squad-ws-*` / `squad-memory-*`（architect 落 `specs/ui/components/studio-page/`）。

### 2.6 exclusive EP 机制统一（enabled + order，修 bug）[v0.0.55]
**背景 bug**：现 exclusive EP（`should_compact`/`do_compact`/`llm_provider`/`web_search_provider`）前后端字段脱节：后端写 `exclusive` 字段、前端按 `enabled` 判断、inventory 不投影 `selected` → UI 多红框 / radio 一个 dot / 切不生效，且后端静默切坏 default scope。
**目标（SPEC CHANGE）**：废弃 `exclusive` 字段，exclusive 语义统一用 `enabled` + `order`——三种 cardinality 共用同一数据模型，保障扩展性/兼容性。
**后端改动（数据定义统一，主线优先）**：
- `setExclusive(implId, scopeId)` 改 enabled 互斥：目标 `enabled=true`，同 point 其他 `enabled=false`。
- `exclusivePick` 改读 enabled：active = enabled 者；多个取 effective order 最小。
- inventory 投影 `selected`（派生、不入库）：`selected = enabled && point 内 order 最小的 enabled 者`，前端不再自算。
- 废弃 `exclusive` 字段，迁移清旧 record。
- 未配置默认态不变：`enabled ?? true` → order 最小者选中。
**前端改动（fix 显示）**：radio `selected` 改用 inventory `selected`（弃用按 `enabled` 瞎猜 → 修「两红框一 dot」根因）。

---

## 3. 关键用户路径（MANDATORY — 每条 ≥1 AT case；E2E 用户自做）

| 路径 | 用户操作链路 | 预期结果 | 覆盖方式 |
|---|---|---|---|
| **路径 1 · session memory 查看/编辑** | playground chat 打开 session → 右侧 ws-panel 切「长期记忆」tab → 见当前 session_memory entry 列表 → 点某 entry 编辑 body → 保存 | entry 列表来自 `session_memory.md`（真落盘）；保存后磁盘 `session_memory.md` 更新；新 session system prompt 的 `memory_session` 注入含新内容 | AT（curl 真服务）+ 用户手动 E2E |
| **路径 2 · user memory 查看/编辑** | nav → 应用设置 → 侧边栏选「全局长期记忆」→ 见 user_memory entry 列表 → 新建一条（type=feedback, why/how）→ 保存 | entry 落盘 `user_memory.md`；新 session 的 `memory_user` 注入含新 entry | AT（curl 真服务）+ 用户手动 E2E |
| **路径 3 · skill evolvable 切换** | nav → skill-page → 某 skill 项切「自进化」toggle off → 见 evolvable=false → agent 后续调 `skill_manage.patch` 该 skill 被拒 | toggle 触发 `PATCH /skill/:name/governance {evolvable:false}`；落盘 frontmatter `evolvable:false`；agent 工具拒绝（isError + 稳定 code） | AT（curl governance + 真服务工具调用） |
| **路径 4 · studio leader 右侧区域** | studio 选 leader → 主区右侧出现 tab 区域 → 切「长期记忆」tab 见该 leader session_memory → 切「workspace」tab 见团队工作区文件树 | leader session_memory 真落盘可编辑；workspace 文件树对应该 squad workspaceDir | AT（curl 真服务）+ 用户手动 E2E |
| **路径 5 · exclusive EP 切换生效** | 应用设置 → 插件 → 扩展点 tab → 选某 exclusive point（如 should_compact）→ radio 切到另一 impl → 刷新页面 | inventory `selected` 指向新 impl；磁盘 `enabled` 互斥正确（新=true，其余=false）；运行时 `exclusivePick` 取到新 impl（compact 行为切换） | AT（curl PUT setExclusive + GET inventory + 验 exclusivePick 真切） |
| **路径 6 · session 并发任务锁互斥** | session A 同时触发 compact + tier1 整理（或两次 compact）→ 第二个 acquire 返 false → 跳过（不堆积） | 同 session 同 taskType 同时只 1 个跑；另一被跳过；不产生幽灵锁；运行任务完成 release 后下一个 acquire 才成功 | AT（直接调 acquire/release 端点或 UT 触发并发） |

---

## 4. UT/AT/ET 范围

### 4.1 UT（白盒，`bun run test`）
- **锁机制抽象**：acquire/release CAS；同 session × 同 task 互斥；不同 session/task 不阻塞；release 后下一个 acquire 成功。
- **governance 简化**：PATCH 只改 evolvable；skill_manage.patch 拒改 evolvable。
- **exclusive EP 统一**：setExclusive enabled 互斥落盘；exclusivePick 读 enabled + order 最小；inventory `selected` 派生正确；旧 `exclusive` record 迁移清掉。
- **memory UI 端点**：GET/POST/PATCH/DELETE 走 managed-store（复用 memory_manage 底层，per-file 锁串行化仍生效）。

### 4.2 AT（黑盒真 LLM 真服务，禁 mock）
> 路径 1-6 每条 ≥1 case，断言真落盘 + 真注入 + 真运行时行为：
> - **路径 1 case**：playground session → GET session_memory 列表 → POST 新建 → PATCH 更新 → 查真落盘 `session_memory.md` + 新 session 启动 system prompt `memory_session` 含新内容。
> - **路径 2 case**：应用设置 → POST user_memory entry（type=feedback）→ 查真落盘 `user_memory.md` + 新 session system prompt `memory_user` 含新 entry。
> - **路径 3 case**：PATCH governance evolvable=false → skill frontmatter 真改 → agent 调 skill_manage.patch 返 isError + 稳定 code + 磁盘不变。
> - **路径 4 case**：leader session GET session_memory（leader 的 sessionId）+ GET workspace tree（squad workspaceDir）。
> - **路径 5 case**：PUT setExclusive（切 should_compact）→ GET inventory 验 `selected` + 磁盘 enabled 互斥 + 调用 exclusivePick 验返回新 impl。
> - **路径 6 case**：并发触发（compact + tier1 或两次 compact）→ 第二个 acquire 返 false / 409；查无并发执行（运行日志/落盘时序）。

### 4.3 ET
**本版本 E2E 用户自做**（用户指示）—— orchestrator **不产出 E2E case**，路径 1-6 的 E2E 由用户基于 `design/ui-demo.html` 手动验证。
→ AT 覆盖全部 6 条路径的契约（最低覆盖要求由 AT 满足）。
→ 视觉保真度门禁（`vision_check.py compare`）由用户手动跑（带设计稿场景）；orchestrator 不产出 compare case。

---

## 5. 不覆盖项（OUT-OF-SCOPE，明确排除）

| 项 | 原因 | 后续 |
|---|---|---|
| **memory 检索（向量召回）** | whole-file 注入足够；非本版本目标 | P1 |
| **session_memory 归档/提升策略** | session 结束 entry 是否提升到 user_memory 未定 | P1 |
| **orchestrator 产出 E2E case** | 用户指示 E2E 自做 | 用户手动 |
| **锁机制的分布式扩展** | 单机客户端产品，内存锁够用；不需要跨进程/分布式 | 不做 |
| **exclusive EP 字段迁移期的双向兼容读** | 一次性迁移清旧 record（启动 lazy migrate，参照 ext_impl_scope §4.3 范式） | 本版本完成 |

---

## 6. 设计稿说明

`reqs/[working] v0.0.55.memory_ui_session_lock/design/ui-demo.html` 覆盖 4 场景：
1. 会话右侧「长期记忆」tab（playground chat）
2. 应用设置「全局长期记忆」入口
3. nav skill 列表双开关（启用 + 自进化）
4. studio workspace（leader/mate 右侧区域）

→ 视觉保真度门禁**用户自做 E2E 验证**（本版本 orchestrator 不产出 compare case）。
→ coder 实现前按设计稿填组件 spec「视觉基线」字段（_conventions.md §9）；doc-modifier 同步。

---

## 7. 概念对齐与 spec 修正清单（MANDATORY — architect/coder/doc-modifier 执行）

本版本涉及 5 处 spec 修正（不是 PRD 凭空发明，是用户需求的字段/机制调整）：

| spec 文件 | 修正内容 | 责任阶段 |
|---|---|---|
| `specs/tech/agent/skills/[P0]skill_definition.md §6/§8` | 删 `mutableLocked` 维度；`mutable → evolvable` 改名；默认值表相应更新 | 架构阶段（architect） |
| `specs/tech/agent/skills/[P0]skill_manage_tool.md` | payload 不含 `evolvable`（原「不含 mutable」改名）；强制规则文案对齐 | 架构阶段 |
| `specs/tech/config/[P0]plugin_config_service.md §2/§4.2` | 废弃 `exclusive` 字段；`setExclusive` 改 enabled 互斥；`exclusivePick` 改读 enabled；inventory 加 `selected` 派生字段 | 架构阶段 |
| `specs/tech/config/[P0]ext_impl_scope.md` | 同步删 `exclusive` 字段引用 | 架构阶段 |
| `specs/tech/agent/context/[P0]context_compact_detail.md §2c` | 配合 §2.4 锁机制——compact 触发点接入统一锁（取代 summaryTask 特定 CAS） | 架构阶段 |

**新概念（需 architect 先落 tech/ui spec 再编码）**：
- **统一 per-session × per-task 锁**（§2.4）：内存锁抽象 + acquire/release + subsumes summaryTask → 落 `specs/tech/agent/session/`（或新 KB）。
- **memory UI 端点**（§2.1/§2.2）：UI 专用 HTTP（不复用 memory_manage 工具）→ 落 `specs/api/`。
- **chat-page / studio-page 右侧多 tab 区域**（§2.1/§2.5）：ws-panel 加「长期记忆」tab + studio leader/mate 加右侧区域 → 落 `specs/ui/components/`。
- **应用设置「全局长期记忆」group**（§2.2）：sidebar 新 group + entry 列表组件 → 落 `specs/ui/components/app-dev-config-page/`。
- **skill-item 双开关**（§2.3）：component-skill-item 加 evolvable toggle → 更新 `specs/ui/components/skill-page/component-skill-item.md`。

---

## 8. E2E 跳过声明（用户指示）

**用户明确指示**：本版本 E2E 测试由用户自做，orchestrator 不产出 E2E case（不委派 e2e-test-designer / executor）。
**仍保留的质量门禁**：
- API 测试**必须**（CLAUDE.md 简化流程：API 测试不可省）—— 路径 1-6 全部由 AT 覆盖。
- coder 单元测试**必须** —— §4.1 范围。
- code-review **必须** —— 文件体量/冗余/职责。
- doc-modifier 同步 specs **必须** —— §7 清单全部落地。

**合并前门禁调整**：CLAUDE.md「合并前门禁」第 3 条（E2E）改为「用户确认 E2E 已自做并 pass」；第 7 条（视觉保真度门禁）改为「用户确认视觉还原可接受」。
