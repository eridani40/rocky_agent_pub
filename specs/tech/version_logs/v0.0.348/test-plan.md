# v0.0.348 测试计划 — 队员面板状态不实时修复（studio session meta hydration）

> 轻量版（纯技术 bugfix，无新交互）。依据：`change_plan.md`（b4a353523，9 决策 + 8 行契约）+ `states/bugs/BUG-member-panel-state-stale-[open].md`。
> 编码与本文档并行，本文档只钉验证门禁，不设计 case 文件（无新增）。

## 0. 范围概览

| 项 | 结论 |
|---|---|
| 变更性质 | 纯前端：web/lib-api（listSessionsByBiz +16）+ studio-meta hook（三 map hydration/竞态仲裁/句柄回收）+ UT 新文件（3 场景 +110）；约 +206/-3 |
| 不动面 | 后端 / API 契约 / 外层 squad list 链路（use-squad-meta 三重保障）/ markReadAndClear 语义（决策⑨） |
| UT | MANDATORY：change_plan 变更清单第 8 行已钉死 3 场景（冷启动/断连重连/竞态）+ 全量 tsc -b |
| AT | **豁免新增**（复核通过，理由 §3）；跑既有冒烟集回归 |
| ET | 既有 studio 2 条回归 + 1 条针对性**临时** case（不入持久库） |

## 1. 路径→case 映射

本版唯一用户可感知路径 = BUG 报告的失败场景被修复：

**P-fix：丢帧窗口后进入/回到 studio，队员面板 running/idle 分组正确（不用等该 session 下一帧）**

| 场景 | 修复机制（决策①③④⑦） | 验证层 |
|---|---|---|
| P-fix-a 冷启动（订阅前已有 run 在进行） | onInit 同步 subscribe + fire-and-forget `GET /session?biz=studio` 全量 hydrate 三 map | UT-a + ET 临时 case 步骤 1 |
| P-fix-b 断连重连（丢帧窗口） | onResumed → 重新 GET 校正（use-squad-meta 同款兜底） | UT-b + ET 临时 case 步骤 2 |
| P-fix-c 切 team（stateMap 全局单例、帧从未到达） | GET 重建语义：以响应为基线重建，新 squad 成员 state 直接进 map | UT-a 覆盖（GET 全量含全部 squad 的 studio 会话）+ ET 临时 case 步骤 3 |
| P-fix-d 竞态（GET 在途新帧先到） | metaMap updatedAt 仲裁，GET 后到不回退新帧 | UT-c（黑盒 ET 不可稳定构造竞态，UT 独占） |
| 回归面 | 外层 squad list 聚合计数（对照组，不动）、markReadAndClear 红点、running spinner、订阅生命周期无残留（决策⑧） | UT 既有测试全绿 + ET 回归 2 条 |

## 2. UT 确认（change_plan 已钉死，本节确认覆盖即验收）

`app/web/src/components/studio-page/__tests__/use-studio-unread-meta-hydration.test.tsx`（+110）：

- **a) 订阅前已 running**：mock GET 返回 state=running → hydration 后 stateMap/runningMap 正确 → 覆盖 P-fix-a/c
- **b) 断连丢帧后重连**：触发 onResumed → 重 GET 合并校正（模拟丢帧期间远端 state 变化）→ 覆盖 P-fix-b
- **c) 竞态**：GET 在途新帧先到（updatedAt 新）→ GET 响应后到不回退 → 覆盖 P-fix-d

门禁补充（超出 3 场景但属既有全局验收，不新增 case）：`bun run test` 全绿 + 全量 `tsc -b`（typecheck 硬验收 = 全量 tsc -b，非局部 tsc --noEmit）。既有 `use-studio-unread-meta-singleton/running-state` 测试全绿 = 回归面确认。

## 3. AT 豁免复核（architect 建议复核：**通过**）

**结论：不新增持久/临时 AT case；执行既有冒烟集回归。**

豁免理由（逐条实证）：

1. **无 API 契约变更，属实**：唯一涉及的后端交互 `GET /session?biz=studio`——`biz` 查询参数是 [v0.0.56] 既有契约（specs/api/overall/04-agent-session.md:42 `biz?: "playground" | "studio"`），handlers/session.ts:78-83 早已支持。前端 `listSessionsByBiz` 只是新增 lib 消费方，端点/payload/状态码零改动。
2. **SSE 帧 shape 不变**：onEvent 只是追加写 `metaMap[sid]=data.updatedAt`（帧消费方内部逻辑），`session_meta` topic 契约（chat-slice.ts:61 帧 shape）不动 → 黑盒 AT 无可断言的契约差异。
3. **「很小改动豁免」不适用（leader 判断正确）**：这是 hook 三层逻辑修复（hydration + onResumed + 竞态仲裁 + 句柄回收），+206/-3，逻辑分支多——但该复杂度属**纯前端状态编排**，AT 黑盒从 HTTP 层不可见（修复全发生在 client hook 内部），唯一可见信号是 UI 呈现 → 归 ET。UT 三场景 + 既有测试全绿承担逻辑正确性。
4. **若强行写 AT 会得到什么**：POST /squad → GET /session?biz=studio 断言 200 + items——测的是 [v0.0.56] 既有行为而非本版修复，无回归价值，徒增冒烟集（已超 ≤20 治理线）负担。

既有冒烟集回归（api-test-executor）：`bash tests/api/lib/run_all.sh` 全量 pass = 确认零 API 层回归。

## 4. ET（回归 2 条 + 临时 1 条，不入持久库）

### 4.1 回归（既有冒烟集子集）

| case | 回归点 |
|---|---|
| studio-squad-status-nav | 成员状态入口 + 面板 running/idle 分组（面板是本版修复的直接消费方；其 UC-2/UC-5 面板验证原为「尽力而为降级观察」，本版修复后应更稳） |
| studio-squad-list-ui | 外层 squad list 聚合计数 + SSE 实时更新（对照组链路，确认未误伤） |

### 4.2 针对性临时 case（1 条，落 states/v0.0.348/verify/e2e/ 留证，不写 tests/e2e/）

**ET-临时：重启后/重连后面板状态正确**（e2e-test-executor 按 case.md 范式现场操作，不留持久文件）：

1. **冷启动基线**：squad 内制造 ≥1 成员 running（给成员发一条慢任务）→ **刷新页面/重启 web**（模拟订阅前丢帧）→ 进 studio 该 squad → 队员面板：该成员在 **running 分组**（修复前：全进 IDLE）；presence 文字与分组一致
2. **断连重连**：面板展开状态下等待/制造 SSE 重连窗口（如 kill 网络或等 keepalive 静默）→ 期间成员状态远端变化 → 重连后**不刷新页面**，面板分组自动校正
3. **切 team**： squad A 面板正确后切到 squad B（其成员帧从未到达过）→ B 面板分组同样正确（非全 IDLE）
4. 留证：每步 screenshot + states/v0.0.348/verify/e2e/<case_id>/steps/（vision_check.py 判定，禁 Read 看图）

判定：步骤 1/3 为核心（确定性高，pass/blocking）；步骤 2 重连窗口制造依赖环境（尽力而为，降级记录不算 fail）。

**不入持久库理由**：修复后该路径并入 studio-squad-status-nav 的面板验证语义（UC-2/UC-5 原本就是状态实时性），持久价值由既有 case 承担；临时 case 的「重启/断连」操作对持久冒烟过重。

## 5. 层级结论表

| 路径/场景 | UT | AT | ET |
|---|---|---|---|
| P-fix-a 冷启动分组正确 | ✅ 场景 a | —（豁免 §3） | ✅ 临时 case 步骤 1 |
| P-fix-b 断连重连校正 | ✅ 场景 b | — | ✅ 临时 case 步骤 2（尽力而为） |
| P-fix-c 切 team 正确 | ✅ 场景 a（GET 全量） | — | ✅ 临时 case 步骤 3 |
| P-fix-d 竞态仲裁 | ✅ 场景 c（独占） | — | —（不可稳定构造） |
| 外层 squad list / 红点 / 回归面 | ✅ 既有测试全绿 | ✅ 冒烟集回归 | ✅ studio 2 条回归 |
| 验证顺序 | UT + tsc -b 全绿 → code-review → AT 冒烟集 → ET（回归 2 + 临时 1）→ doc-modifier → 合并 | | |
