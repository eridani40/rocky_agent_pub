# v0.0.151.t2_consolidate — API 变更

> 版本类型：功能版本（天级 t2 整理任务）+ 一个 test-only 测试基建端点。生产端点变更（`consolidation` app_config group + `GET /consolidation/status`）记录在 `specs/api/overall/03-config-center.md §2.6/§2.7`（v1.9）。**本文件只记录 test-only 端点**——对齐 `POST /session/:id/run`（`v0.0.69.test_refactor/change_log.md`）先例："仅一个新端点，且为 test-only，不进生产 API 契约"。

## 新增：`POST /test/consolidation/run`（test-only 同步触发）

**背景**：PRD 明确排除手动"立即整理"触发（生产 UI 无此入口），consolidation 只能靠 `SchedulerEngine` 天级 cron 到点触发。AT（黑盒 HTTP，`case.yaml` 纯静态 DSL，`wait`/`poll` 上限 60s）无法可靠等一个 `HH:mm` 粒度的到点，也无法在 case 里动态算"下一次 04:00 还有多久"。为让 AT 能覆盖收敛逻辑（合并/去重/容量收敛/双重 skip），新增本端点：**同步跑一次 `runConsolidationTier2`，直接返回结果**，不经调度器。

技术权威：`specs/tech/scheduling/[P1]consolidation_job.md §7`（架构落点）+ `specs/tech/agent/memory/[P0]consolidation_tier2.md §5`（`runConsolidationTier2` 分层说明）。

### Gate（双重，生产绝不暴露，对齐 `/session/:id/run` + `/test/stub` + `/test/llm-mode` 既有模式）
- **router 层**：`process.env.NODE_ENV !== 'test'` → 直接 404，不进 handler。
- **handler 层**：同样 gate，防 handler 被其他模块 import 绕过 router 直接调。

### 请求
| method | path | body | 说明 |
|---|---|---|---|
| `POST` | `/test/consolidation/run` | 无（空 body） | 不接受任何覆盖 `app_config.consolidation` 的参数——本端点只读现有 config（含 `modelId`），不是隐藏的第二套配置入口 |

### 响应

`200`（**同步**，await 到三段全部结束或全部 skip 才返回，不是 202）：

```jsonc
{
  "globalSkill": { "action": "merged" /* | 'archived' | 'no_change' */, "detail": "..." },
  "globalMemory": { "action": "no_change", "detail": "..." },
  "sessions": [
    { "sessionId": "01K...", "result": "skipped_no_activity" },
    { "sessionId": "01K...", "result": "skipped_empty_memory" },
    { "sessionId": "01K...", "result": { "action": "merged", "detail": "..." } }
  ],
  "summary": "全局 skill 归档 2 条 / memory 无变化 / 3 个 session 已整理（2 跳过）",
  "skippedReason": null   // 模型未配置/不可用时填字符串原因，其余字段为空壳
}
```

- **模型未配置/不可用**（`app_config.consolidation.modelId` 缺失或反查不到 provider）：`200` + `{"skippedReason": "model_not_configured", ...其余字段为空/null}`——**不是错误**，是合法的业务结果（与真实调度路径的语义一致）。
- 三块工作严格串行执行（同真实调度路径，`consolidation_tier2.md §3`），本端点只是同步 await 到完成再一次性返回，不改变执行顺序/串行语义。

### 状态码
| code | 场景 |
|---|---|
| 200 | 同步完成（含"模型未配置"这类合法 skip 结果） |
| 404 | 非 test env（gate） |
| 405 | 非 POST |
| 500 | `runConsolidationTier2` 内部未捕获异常（理论上 best-effort 吞异常后不应触发，兜底） |

### 副作用范围（MANDATORY 明确定义——是否触碰调度状态）

| 状态 | 是否写 | 理由 |
|---|---|---|
| `ConsolidationPersistenceAdapter.lastResult`（`lastRunAt`+`summary`，供 `GET /consolidation/status` 读） | **写** | AT 典型验证序列是"seed 数据 → POST 触发 → 断言收敛结果 + `GET /consolidation/status`"，后者需要能看到本次触发的结果；该状态是只读可见性投影，无调度语义 |
| `Job.lastFiredAt`（真实调度 job 的 at-most-once 续接锚点） | **不写** | 若本端点也推进 `lastFiredAt`，会静默扰动同进程内真实 job（若 `enabled=true`）的下次到点计算——AT env 的 `SchedulerEngine` 是活的（`SCHEDULER_TICK_MS` 被 test.env 调快），这是测试路径污染调度状态的隐蔽副作用，故明确不碰 |
| `SchedulerEngine` 的 `inFlight`/`jobs` Map | **不涉及** | 本端点完全不经过 `engine.tick`/`handler.fire`，是独立调用路径 |

### 不影响现有契约
- 不经过 `SchedulerEngine`/`ConsolidationJobHandler.fire()`——即便 `app_config.consolidation.enabled=false`（boot 时未注册 job），本端点仍可调用。
- `POST /config/app?group=consolidation`（§2.6）+ `GET /consolidation/status`（§2.7）零改动——本端点是独立新增，不复用/不修改它们的 handler。
- 不进 `specs/api/overall/03-config-center.md`（对齐 `/session/:id/run` 不进 `04-agent-session.md` 的先例，test-only 端点版本级记录在此）。
