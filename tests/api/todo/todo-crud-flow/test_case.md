# todo-crud-flow — todo 工具全 action 链路（LLM 决策建 todo + HTTP CRUD 契约）

**模块**：todo（新板块，v0.0.223 引入）
**断言面**：Resp（HTTP 20-todo.md 全端点契约）+ 真调 minimax 行为面（agent 自主调 todo 工具建结构化主 item）
**版本**：v0.0.223（新建）；v0.0.190 真实调 API 范式（无 record/replay/frame_checks）

## 覆盖核心逻辑

本 case 覆盖 UC-223-TODO-CREATE（建 todo 全流程，PRD §3）——todo 是新板块 + 新 LLM 不确定性场景（agent 自主维护 todo 决策链路），入选 AT（≤20 内直接进，test-plan §0）。

### Phase A — LLM 决策建 todo（不确定场景，AT 入选核心理由）

| 步 | 行为面 | 断言 |
|---|---|---|
| A1 | 真调 minimax，directive prompt → agent 调 todo 工具 add_item（desc + source=user_message + output=file + memo） | run 完成 `.state == "idle"` + `.messages exists` |
| A2 | GET /session/:sid/todos 读 todo store | `.items exists` + `.items[] any .output.type == "file"`（agent 建的结构化条目落 store） |

**为什么这样断**：LLM 是否调 todo 工具 + 是否填结构化 output 字段是不确定的（这正是 AT 入选理由）。断 `output.type=file` 既证明 agent 走了 todo 工具的新 schema（非偶然写文本），又不依赖 desc 字面精确匹配（LLM 措辞有弹性）。不断 desc marker —— 避免 LLM 措辞偏差致假 fail。

### Phase B — HTTP 契约确定性链路（20-todo.md 全端点）

| 步 | 端点（20-todo.md §） | 断言 |
|---|---|---|
| B1 | POST /todos（§2.2）source/output/memo 全字段 | 201 + `.itemId exists` |
| B2 | POST /todos/:itemId/steps（§2.5） | 201 + `.itemId`/`.stepId exists` |
| B3 | PATCH /todos/:itemId/steps/:stepId（§2.6）status=done（free-form 跃迁 not_started→done） | 200 + `.itemId exists` |
| B4 | PATCH /todos/:itemId（§2.3）status=skipped（free-form 跃迁） | 200 + `.itemId exists` |
| B5 | POST /todos/cleanup（§2.7） | 200 + `.removed >= 1`（skipped 主 item 被清理 = 状态确改 + 清理生效的间接正向证明） |

**free-form 状态机的 AT 表达**：todo 5 态任意跃迁不报 illegal_transition（todo_tools.md §2.3）。AT 只做正向断言（PATCH 返 200 + cleanup 移除 skipped item 间接证状态确已改）；「非法 status → invalid_status」「跃迁不报 illegal_transition」的否定语义 AT check 表达不出（无否定量词），由 UT（todoTool 5 态 free-form）覆盖。

## setup 结构

POST /session 建 playground session（parent.main profile 持 todo 工具，todo_tools.md §5），预绑 minimax provider/model（test pool ULID `01KVJMPG2EZ1078MCT9JH4J5HG` / `MiniMax-M3`）。playground = parent.main，todo 工具 + todo reminder provider 均生效。

## 已知边界（AT 表达范围）

- **A2 LLM 不确定性**：minimax 若不调 todo 工具或未填 output=file → A2 fail（真信号：prompt 集成 gap 或工具未绑）；case 整体 fail。Phase B 独立运行不受影响（step 间不串联回滚）。
- **B3 断 `.itemId exists` 而非 `.stepId exists`**：spec 20-todo.md §2.6 声明 PATCH steps 返 `{itemId, stepId}`，但 T1 实际实现 PATCH 返 `{itemId}`（coordinator 第 2 轮同步契约）；按代码实际写（陷阱 14），doc-sync 待办记 context.md 交 doc-modifier 统一修 spec。
- **状态 free-form 否定语义走 UT**：AT 不断「非法 status 被 400」「跃迁不报 illegal_transition」（无否定量词，tests-api-dsl-no-count-no-negation），UT 覆盖。
- **status 默认值**：B1/B2 显式传 status=not_started；缺省行为（not_started）由 UT 覆盖。

## DSL 写不出的目标（转 UT 兜底）

| 目标 | 为什么 AT 写不出 | UT 兜底 |
|---|---|---|
| 非法 status → 400 invalid_status | 需「断 400」可写（object-form status:[400]），但本 case 聚焦正向链路；错误路径另立或 UT | todoTool UT（invalid_status 分支） |
| 跃迁不报 illegal_transition | 否定语义（无 absent/否定量词） | todoTool UT（5 态 free-form 任意跃迁不报错） |
| cleanup 后 done/skipped item 全清（残留=0） | 否定（无 count/absent over items） | TodoStore UT（cleanup_finished 删 {done,skipped}） |

## 引用

- `specs/api/overall/20-todo.md` §1/§2 — Todo 资源模型 + 全端点契约（HTTP 断言权威）
- `specs/tech/agent/tools/[P1]todo_tools.md` §3/§2.3/§5 — 7 action schema + 5 态 free-form + profile.toolBound 绑 parent.main
- `specs/prd/version_logs/v0.0.223.md` §3 UC-223-TODO-CREATE — 建 todo 全流程需求
- `states/v0.0.223/verify/test-plan.md` §1/§2 — case 安排 + AT 入选理由
