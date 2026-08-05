# v0.0.210 跨版本发布说明 — Academy 全新板块

> 跨子系统发布说明（tech 各 KB 的 `log.md` 是位置轴，本文件是版本轴汇总）。本文件总结 v0.0.210 的交付物 + 实现偏离。

## 交付物（全部完成）

### tech academy KB（全新建立）
- 8 个 spec 文件 + index.md（总起）+ log.md（位置轴）：
  - `[P0]academy_overview.md`：双引擎架构 + 8 开放点决议
  - `[P0]data_model.md`：7 entity schema + store 接口 + 目录规范
  - `[P0]session_kind_extension.md`：3 新 academy session-kind + 9 profile/scope 矩阵
  - `[P0]training_engine.md`：训练引擎状态机 + runTurn + acceptGate + 断点续跑 + a2a 事件回推
  - `[P0]train_student_tool.md`：1 工具 13 action 契约 + 权限矩阵
  - `[P0]evaluation.md`：数据集 + 评估器体系 + fan-out 直调
  - `[P0]academy_skills.md`：3 个优化 skill 形态
  - `[P1]squad_derive.md`：squad 员工从学生版本派生

### prd / api / ui
- `specs/prd/overall/12-academy.md`：261 行产品权威 + 7 关键用户路径（UC-A ~ UC-G）
- `specs/api/overall/18-academy.md`：HTTP 端点契约 + dispatch 顺序 + 错误码
- `specs/ui/overall/12-academy.md`：UI 板块视觉/布局契约
- `specs/ui/components/academy-page/`：21 个组件 spec（coder 编码前落）
- `specs/ui/components/_conventions.md §12`：data-action-key 规范（开发实现约定）

### app 布局手册
- `specs/ui/overall/00-app-guide.md`：§2 nav-rail 加 Academy 🎓 第 3 业务入口 + §3.3 academy 操作路径

## 实现偏离（spec → code 对齐记录）

实现期间发现的 spec 与代码偏差，已在 doc-modifier 阶段 5 统一对齐到**代码实际**（spec 落后是常态，照代码改 spec）。主要偏离：

1. **TrainingEngineDeps.llmCaller → llmPort**：spec 写 LlmCaller 全签名，实际走 AcademyLlmPort 窄端口（避免耦合 InvokeContext 全套字段）。bootstrap.ts 通过 llm-caller-adapter.ts 适配。
2. **deliverTo sender.source='system'（非 'agent'）**：训练引擎不是 session 无 sessionId；与 scheduling handlers 同模式。needReply 走 metadata。
3. **不存在 training.* SSE 事件**：design 双引擎原意是 a2a 投递（deliverTo 推 message 到 coach inbox）；早期 architect 草案误写 SSE 事件类型，已删除。前端走 4s 轮询 + 消息驱动 softReload。
4. **AcademyStore 拆分为两个文件**：academy-store.ts（CRUD facade ~178 行）+ academy-store-ops.ts（fork/adopt/createInitial 业务原语 ~210 行）。
5. **entity 名复数化**：classroom 单数；students / student_versions / training_tasks / training_turns / datasets / graders 复数（CrudStore 一级分片，避免与 classroom 冲突）。
6. **落盘路径平铺**：`{root}/academy/{cid}/{entity}/{id}.json`（CrudStore 一级分片，spec §1 原写嵌套路径已对齐）。
7. **academy-paths 死代码删除**：taskRoot / turnFilePath 全仓零消费已删；version 工作区路径保留。
8. **forkVersionWorkspace base 允许 process**：曾因误加 formal-only 校验致 multi-turn round2+ 500，已从源头去除（INV-5 原子性 + INV-6 workspaceDir 不可变都与 base 类型无关）。
9. **parentFormalVersionId 字段名误导**：multi-turn 场景下指向 process 版本（不是 formal）。schema 仅约束 ulid+required=false。
10. **mapper impl 路径**：`app/plugins/builtins/rocky_context/prompt/academy-*.ts`（非 change_plan 写的 `impls/system-prompt-mapper/`，该路径不存在）。
11. **groups.json 未改**：academy mapper 走 plugin.json extImpls + scope yaml impls 列表激活。
12. **SessionConfig 加 academyContext 鸭子类型字段**：mapper 经 `ctx.config.academyContext` 读 academy 实体；由 `academy-context.ts buildAcademyContext` 在 resolveConfig 回调（每轮 prompt 组装）按 role 裁剪注入。
13. **CreateSessionInput/SessionRecord academy 4 字段 plumbing**：A/B 节加字段，C 节漏传递；读侧投影链 4 处补齐（Session interface / toSession / getSessionContext / setBuildAgentToolContext）。
14. **AcademyHandlerDeps 加 dataDir + appConfig**：task 描述只列 4 字段；router 注入时从 bs 层取（workspace 路径根 + resolveModel 数据源）。
15. **academy-routes dispatch 最长前缀优先**：R1 review Critical bug——规则 1 generic `/academy/classroom/` 吞深层路径，6 组端点全 404；改最长前缀优先 + 32 dispatch UT。
16. **i18n 实际路径**：`app/web/src/i18n/locales/{zh-CN,en}/academy.json`（change_plan 写 `src/locales/` 不存在）。
17. **train-student action=start 工具层不建真实 coach session**：只 putTask + 占位 coachSessionId；真实 coach session 由 HTTP handler 层（`academy-training-task-create.ts`）建。
18. **classroom.defaultModel 复合字段**（用户追加需求）：`{providerId?, modelId}`，建学生 fallback 链中间档 + head/coach picker 顶部「默认模型」项。
19. **propose→head 未投递**：当前实现只 deliverTo(coach)；head 发现机制（task 无 headSessionId 字段、engine deps 无 sessionStore）待后续版本补，UI 轮询兜底。

## 测试覆盖

- UT：academy 域 171+ 测试（schema / store / engine / handler / dispatch / context / mapper / derive）+ 3 academy skill frontmatter 闭合。
- AT：2 case 真实调 minimax（train-multiturn-flow + train-accept）100% pass。
- ET：1 case 板块冒烟（academy-smoke）6/6 步全 pass。
- packaged 验证：4 护栏全绿（依赖归属 / plugin 进 asar / 运行时配置 / 路径展开）+ 真后端 HTTP 仿真。
