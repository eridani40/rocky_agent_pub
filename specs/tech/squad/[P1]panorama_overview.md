---
type: concept
title: Panorama 子系统总起（业务全景）
priority: P1
status: active
updated: 2026-08-03
since: v0.0.189.dsl_board
related: [[P1]panorama_dsl.md, [P1]panorama_store.md, [P1]panorama_validation.md, [P1]panorama_migration.md, [P1]panorama_tools.md, [P1]panorama_http.md, [P1]panorama_builtin.md]
---

# Panorama 子系统总起（业务全景 / Business Panorama）

> 定位：squad leader 用声明式 DSL 搭建的**可操作业务数据看板**——squad 的业务数据可视化与操作体系。**agent 是看板作者，用户是操作者**。
> 需求权威：`reqs/[working] v0.0.189.dsl_board/req.md`（10 条决策）；调研权威：`specs/research/v0.0.189.dsl_board/panorama_{dsl_schema,validation,migration}.md`；PRD：`specs/prd/version_logs/v0.0.189.dsl_board/prd.md`。

## 1. 是什么

Panorama（代码 id `panorama`）让 squad leader（agent）通过生成一份 YAML DSL 来声明：有哪些业务实体（entity）、每个实体有哪些字段和状态机、看板长什么样（views = kanban/table/bar_chart）。DSL 经四层校验 + 自我修复回路后落盘，用户随即在 Studio 看到一个可拖拽、可新建/编辑、SSE 实时刷新的双向工作面板。

| 维度 | 业务全景（panorama） |
|---|---|
| 内容 | agent 搭建的业务数据看板（DSL 声明式 schema） |
| 作者 | squad leader 生成 DSL |
| 数据 | DSL 主面 + 纯数据实例（**刻意无 OKF md 轨**） |
| 存储 | `squads/{id}/panorama/`（独立目录，纯文件） |

## 2. 核心概念

| 概念 | 一句话 | spec |
|---|---|---|
| **DSL** | 一份 YAML，声明 meta/version/entities/views 顶层四块；设计目标 = LLM 生成可靠 + 可校验 | `[P1]panorama_dsl.md` |
| **实体（entity）** | 业务对象（如 pipeline_run / deployment / task），含字段 + 状态机 + display | `[P1]panorama_dsl.md §4` |
| **system entity**（v0.0.243） | 系统固定 entity（首个 = task），落盘进 squad schema（和 book 平级）+ `system:true` 标记（leader 不可 edit/delete）；lazy migration chokepoint（`ensureSystemEntities`）幂等注入 | `[P1]panorama_builtin.md` |
| **视图（view）** | 看板的一个 tab；component = kanban / table / bar_chart | `[P1]panorama_dsl.md §5` |
| **view.filter**（v0.0.240） | view 默认过滤声明（field:value 精确匹配），前端 fetch 透传；修"3 table 筛出一样" | `[P1]panorama_dsl.md §5.0` |
| **状态机（states）** | entity 上的状态字段 + transitions 表 + terminal 锁；拖拽 = 状态跃迁的投影 | `[P1]panorama_dsl.md §4.3` |
| **校验引擎** | 四层（语法→schema→语义→数据安全），单一入口，三路写入共用 | `[P1]panorama_validation.md` |
| **迁移引擎** | 增量变更自动生效；破坏性变更须 agent 提交 migration 方案 + 审计 | `[P1]panorama_migration.md` |
| **事件流** | append-only `events.jsonl`，双侧（agent/用户）操作可见，SSE 推送 | `[P1]panorama_http.md` |
| **实例 store** | 泛化 KV（entity name → bucket）+ DSL 注册表，走 CrudStore FS engine | `[P1]panorama_store.md` |

## 3. 与其他子系统的关系

```
              ┌── [P1]panorama_dsl.md          (DSL 规范权威)
              │
              ├── [P1]panorama_store.md         (存储布局 + 泛化实体 store + CrudStore 复用)
              │       └── persistence/[P0]fs_crud_store_engine.md  (FS engine + 原子写 + 锁)
              │
panorama ─────┼── [P1]panorama_validation.md    (四层校验，唯一规则源)
   子系统     │
              ├── [P1]panorama_migration.md     (增量/破坏性迁移 + 审计 + 备份)
              │
              ├── [P1]panorama_tools.md         (panorama(action) agent 工具，对齐 squad_tools §0)
              │       └── [P1]squad_tools.md §0  (通用约定基准)
              │
              └── [P1]panorama_http.md          (HTTP API + SSE)
                      └── specs/api/overall/14-panorama-endpoints.md  (端点契约，AT 唯一依据)
                      └── sse channel (复用现有 session/squad 事件总线)
```

**对外协作点**：
- 工具注册：`app/server/src/squad/panorama/` 新模块（dsl parser / validator / migration / store / tool / http / sse）。
- HTTP 路由：挂 `/squad/:id/panorama/*`（对齐 11a-squad-endpoints.md 风格）。
- SSE：复用现有全局单 SSE 通道（`GET /sse` + topic/group 订阅），topic = `panorama`（静态注册类别）+ per-squad group 路由键 `panorama:squad:{squadId}:entity`（详见 `[P1]panorama_http.md §4.1`）。
- UI：v0.0.240 起全景从独立路由态（`MainView {kind:'panorama'}` 已删）改为**首页第二栏内嵌**（`<PanoramaRoute>` 无 onBack 头部，由 `component-seats-panel` 第二栏承载）；组件落 `specs/ui/components/studio-page/component-panorama-*.md`。
- skill：`panorama-designer` builtin skill（`app/plugins/builtins/skills/panorama-designer/`），leader 默认继承（fallback enabled=true）。
- workspace 初始化：`createSquadService` step7 加 `panorama/` 目录骨架。

## 4. 边界

| 管 | 不管（→ 别处） |
|---|---|
| DSL 规范（schema/字段类型/状态机/card 模板/护栏） | LLM 如何生成 DSL（→ skill `panorama-designer`） |
| 四层校验引擎 + 错误码表 | agent 修复策略（→ skill） |
| 泛化实体 store（DSL 驱动，不建 SchemaDef） | CrudStore FS engine 本体（→ `persistence/`） |
| 迁移引擎（增量/破坏性 + 审计 + 备份） | 启动期全局 migration manager（→ `migration/`） |
| `panorama(action)` 工具（action 表 + 权限 + 错误码） | tool_execution_engine（权限校验框架 → `agent/tools/`） |
| HTTP 端点 + SSE 推送协议 | SSE 通道基建（→ `sse_channel`） |
| events.jsonl append-only 事件流 | 跨实体聚合查询 / 搜索引擎（v1 外） |

## 5. 核心设计原则（跨文件不变量）

1. **规则唯一源 = DSL**——用户拖拽 / agent 工具 / 直接 API 三个写入口共用同一校验器实例（决策 6），规则从同一份 DSL 派生，不硬编码，不漂移。
2. **存储不建 SchemaDef**——动态实体走泛化 KV（entity name → bucket）+ DSL 注册表，但仍用 CrudStore FS engine 做文件读写（复用原子写 / 锁 / sharding 能力）。理由：panorama 实体是 agent 运行时定义的，SchemaDef 是编译期静态的，动态实体无法预建。
3. **数据完全隔离**——panorama 走独立目录 `panorama/`，不引数据库，无 OKF md 轨（决策 7/8）。
4. **校验是原子门**——dryRun 失败绝不落盘；partial success 不存在。四层短路/收集规则见 `panorama_validation.md §1.1`。
5. **SSE 复用现有基建**——不另起通道，复用 session/squad 的事件总线（topic/group 订阅模型，决策对齐 `06-studio.md` SSE 策略）。
6. **四面对齐**——DSL schema 字段 / 工具 action 参数 / HTTP 端点 payload / UI 渲染契约一致（panorama_dsl 是字段权威，panorama_tools/panorama_http/UI 对齐）。
7. **system entity = 落盘普通 entity + system 标记 + lazy migration**（v0.0.243）——固定 entity（task）落盘进 squad schema（和 book 平级，get_schema 可见），`system:true` 标记（leader 不可 edit/delete，三段闭环：parser 不识别 + `checkSystemEntityImmutable` 拒字段漂移 + `injectSystemEntities` 强制覆盖）；所有 schema 读取走 `ensureSystemEntities()` 单一 chokepoint（lazy 注入，幂等）。→ `[P1]panorama_builtin.md`
8. **归档不内置，靠字段 + filter**（v0.0.240）——panorama 无内置 archive 概念；entity 声明 `archived: boolean` 字段 + view 加 `filter: { archived: false }` 即得"默认隐藏归档"。task system entity 是首例。→ `[P1]panorama_dsl.md §5.0`

## 6. 与 squad 工作目录的关系

- panorama = squad 唯一的业务数据看板体系（DSL + 纯数据实例），落独立目录 `panorama/`。
- 入口：首页第二栏内嵌（v0.0.240 起从独立路由态改为 SeatsPanel 底部「项目全景」栏内嵌 `<PanoramaRoute>`，详 `06-studio.md §4`）。
- panorama 与 squad 工作目录其他内容（outputs/reports/交付/temp 等文件产出）完全独立——后者是 agent/用户的自由 markdown 产出，前者是结构化业务数据看板。

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
