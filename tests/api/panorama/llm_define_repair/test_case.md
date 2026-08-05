# llm_define_repair — leader 首次搭建含校验失败自修复回路

> module: panorama · 覆盖 PRD P2 · AT 冒烟集新增（一进一出）
> 契约依据：`specs/api/overall/14-panorama-endpoints.md`（端点）+ `specs/tech/squad/[P1]panorama_validation.md`（校验返回结构）

## 目标

验证 squad leader 用 DSL 搭建业务看板的**核心回路**——「生成 → 四层校验失败 → 按 suggestion 自修复 → 落盘」。
这是 v0.0.189 引入的**新 LLM 不确定性场景**（leader 生成 DSL 是 LLM 行为），符合 AT 冒烟集入选标准，
故新增 1 条并遵守一进一出（淘汰建议见末节）。

## 前置条件

- 编码完成后：leader studio session 已挂载 `panorama` 工具 + `panorama-designer` skill（v0.0.189 实现）。
- **框架（v0.0.190 新框架）**：真实调 API，无 stub 声明 / 无 MODE / 无录制回放。Leg 3 真调 minimax
  （`squad.modelDefault=MiniMax-M3` 经 resolveConfigBySid 解析，同 `compact_model_directive` 模式），
  429/529/503 限流 → `skipped`（不算 fail、不阻塞聚合）。
- **环境准备**：`env_start.sh` 自动起 env + copy dev config（web_search/see_image/runtime/web/consolidation）；
  providers 用 test pool。本 case 无额外环境准备要求，setup 内自建 squad 自足，teardown 级联清理。

## 流程（setup + 3 段 steps + teardown）

**setup**
- `POST /squad` 建队（事务同建 leader member + leader studio session，role=leader/biz=studio）→ 存 `squadId` / `sid`。
- `GET /session/{sid}` 校验是 studio leader 会话。

**Leg 1 — 校验契约（dryRun，不落盘）**：自修复回路依赖的结构化反馈
- validate 含语义错误 DSL → 断言 `ok:false` + `errors[]` 含 `layer=="semantic"`、`code~="panorama_unknown"`、`path/message/suggestion` 存在。
- validate 修正后 DSL → 断言 `ok:true`。

**Leg 2 — 落盘 + 操作面验证（确定性）**
- `PUT /squad/{squadId}/panorama/schema` 落盘 → `ok:true`。
- `POST entities/pipeline_run` 建实例 → `ok:true` + `id` 存在（证明 board 可操作）。
- `GET schema` → `dsl` 非空 + 含 `pipeline_run`（持久化回读一致）。
- `GET events` → `events[]` 含 `type=="board.defined"`（审计记录）。

**Leg 3 — LLM 自修复冒烟（AT 入选依据）**
- `POST /session/{sid}/run`（同步等终态，真调 minimax）：显式 prompt 要求 leader 用 panorama 工具
  定义 pipeline_run 看板、先 dryRun、按 suggestion 修复、再落盘 → 断言 `.state == "idle"`。
- `GET schema` → `dsl` 非空（leader 落盘了它自己生成的 board）。

**teardown**
- `DELETE /squad/{squadId}`（级联清理 leader session + panorama 数据）。

## 核心断言清单

| step | 断言 | 依据 |
|---|---|---|
| validate 错误 DSL | `ok==false` + `errors[] any layer=="semantic"` + `code~="panorama_unknown"` + `path/message/suggestion exists` | validation §1.2 / §4 |
| validate 修正 DSL | `ok==true` | validation §1.3 dryRun |
| PUT schema 落盘 | `ok==true` | endpoints §1.2 |
| create 实例 | `ok==true` + `id exists` | endpoints §2.2 |
| GET schema | `dsl exists` + `dsl ~= "pipeline_run"` | endpoints §1.1 |
| GET events | `events[] any type=="board.defined"` | endpoints §3.1 |
| leader run | `state == "idle"` | /run 同步终态 |

## broken DSL 注入的语义错误（2 类，均 Layer 3）

1. `pipeline_ref: { type: ref, entity: ghost_team }` → `panorama_unknown_ref_target`（ref 指向未声明实体）。
2. kanban `group_by: nonexistent_status` → `panorama_unknown_group_by`（分组字段不存在/非 enum）。

二者同属 `panorama_unknown_*` 语义层，与 PRD 列举的 `card {foo}` 示例等价（验证同一类「编译期跨引用闭合」错误）。

## 已知约束：DSL card 模板不用 `{field}` 插值

AT 框架 `case_loader._check_interp_refs` 在 load 期对 body 字符串做 `{var}` 静态校验——
**任何**未在 save 中定义的 `{word}` 都会被拒载（字面花括号会被误判为插值变量）。
因此本 case 的 DSL card 模板一律用字面标题（如 `title: 流水线运行`），语义错误改用 ref/group_by 两类触发
（同属 panorama 语义层 `panorama_unknown_*`），不损失对「结构化错误反馈」这一自修复回路核心的覆盖。

## 引导词确定性

leader run 的 prompt 显式点名：用 `panorama` 工具、实体名/字段/枚举/状态机/视图类型、先 dryRun、按 suggestion 修复、再 define 落盘、禁止追问——
对齐 `agent_spawn_sync` 的确定性写法，降低真 LLM 轮的行为方差（v0.0.190 起无录制，每轮都是真调）。

## 一进一出：候选淘汰建议

当前 AT 冒烟集 12 条，新增本条后 13 条（超 5~10 上限）。**主候选淘汰**：

- `consolidation/t2_daily_consolidation` — 维护成本最高（3 个 llm stub、长耗时、对 consolidation prompt/schema 变更敏感）；
  其确定性契约（整理端点行为）可回归 UT 覆盖。**权衡**：它测的是「真 LLM 产出整理摘要」这一独特行为，淘汰会损失该 LLM 路径的冒烟覆盖——
  是否最终淘汰由 **orchestrator + 用户** 裁定（test-plan 原建议的「v0.0.117 board 编辑对齐类」在当前 case 集中已不存在）。

备选：若需保留 consolidation 的 LLM 覆盖，可评估 `skill-market/market-search`（走 `web_fetch` stub 而非 llm，
属工具链路冒烟，LLM 不确定性成分较低），但因其覆盖唯一能力（web 工具），不建议轻易淘汰。

## 关联文件

- 契约：`specs/api/overall/14-panorama-endpoints.md`、`specs/tech/squad/[P1]panorama_validation.md`、`[P1]panorama_dsl.md`、`[P1]panorama_tools.md`
- 测试计划：`states/v0.0.189.dsl_board/verify/test-plan.md §3`
- 同类参考：`tests/api/compact/compact_model_directive/case.yaml`（squad+leader setup 模式）、`tests/api/multi_agent/agent_spawn_sync/case.yaml`（录制引导词确定性写法）
