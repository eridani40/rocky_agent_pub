# v0.0.14 Change Log（accumulateUsage 激活 + BUG-003 修）

> 2026-06-22 · 简化流程：coding → code-review → api-verify → doc-modifier。
> 验证全绿（UT + AT 真 LLM PASS：`session_usage_accumulate` 真 LLM 一轮验证 ratio 学习收敛 ~0.6009 + session usage view 真聚合 + session_usage_update event 真发）。

## 1. 背景

v0.0.13 时两件事标 defer/known-issue：
- **accumulateUsage 标 no-op/defer**（D3.3 stretch）：v0.0.13 S3 只做 per-call 13 字段校准，session 级累计 + ratio 学习 + session_usage_update 真发全部推迟。
- **BUG-003 标 known-issue**（PluginManager default 注入）：`extractConfigDefaults` 未读 manifest properties → ext impl config default 未注入。

v0.0.14 两件都做：
- accumulateUsage **激活**（三分区累计 + ratio 学习 + session_usage_update event 真发 + getUsageView 真聚合）。
- BUG-003 **修复**（extractConfigDefaults 读 `properties.{key}.default`）。

## 2. 变更：accumulateUsage 激活（SessionStore）

### 2.1 实现路径

`session-store.ts.accumulateUsage()` 激活：读该分区 AccumulatedUsage → 各字段 Σ + llmCallCount++ → 写回 SessionUsageMeta；type=current 时按 §7 学 ratio（sliding window=3 取中位数）；若有 parentSessionId → 递归 `accumulateUsage(parent, "sub", usage)`。

`session-store.ts.getUsageView()` 激活：从 SessionUsageMeta 三分区 AccumulatedUsage + RatioWindow + contextWindowUsage 派生 `SessionUsageView`（不再返零值）。

`session-store.ts` 完成后内部真发 `SessionEvent(type=session_usage_update, data=SessionUsageView)`，经 EventHub topic=`session_panel` group=`session_id:<sid>` 发布（链路 v0.0.12 已就绪，仅是「让事件真能发」）。

### 2.2 ratio 学习行为

| 属性 | 值 |
|---|---|
| 学习时机 | `accumulateUsage(type="current")` 时 |
| sample | `clamp(usage.input_total_tokens / usage.inputCharCount, 0.2, 5.0)` |
| 窗口 | sliding window size=3，取中位数 |
| 冷启动 | 窗口未满（前 3 次 current 分区 LLM 调用）期间 fallback 1.0 |
| 实测收敛 | minimax ratio ≈ **0.6009**（3 轮生效后） |

### 2.3 仍 future（不阻塞本版本）

- **Run record per-run usage 字段**：v0.0.14 走「SessionUsageMeta 内存累计（meta 已落盘）」路径；崩溃恢复靠 meta 落盘，不靠 Run record 重建。后续若需 per-run usage 视图再补 Run 字段。
- **前端 usage 面板 UI**：后端 view/event 已就绪可被订阅，但 v0.0.14 未引入前端 usage 展示组件（独立产品决策）。
- **prevSnapshot 增量 append 路径**：性能优化 defer。

## 3. 变更：BUG-003 修复（PluginManager default 注入）

### 3.1 根因

`PluginManager.extractConfigDefaults` 未读 manifest `properties.{key}.default`，导致 ext impl config default 字段缺失 → 用户未在 config 页显式配值时 impl 收不到默认值。

### 3.2 修复

`plugin-manager.ts.extractConfigDefaults`：遍历 `schema.properties`，读 `properties.{key}.default`，注入 ext impl config defaults 对象。manifest 声明的 default 真注入。

### 3.3 状态

- **BUG-002**（enqueue clear 回归，v0.0.13 已真修）：v0.0.14 维持 **closed**。
- **BUG-003**（PluginManager default 注入）：v0.0.14 **fixed → closed**（见 `states/v0.0.14/bugs/BUG-003-...-[closed].md`）。
- **BUG-004**（UT stale 409 assertion，v0.0.12 已 closed）：v0.0.14 维持 **closed**。

## 4. 文档同步（本次完成）

| 文件 | 更新点 |
|---|---|
| `specs/tech/agent/session/[P0]session_usage.md` | version 3.x → 4.0；§1 去掉「仍 future / no-op」标注；§10 从「stretch 激活条件」改为「已激活状态」；§11 版本 bump |
| `specs/tech/progress.md` | `context_and_memory` / `session` 板块状态：accumulateUsage 未激活 → v0.0.14 激活；`session_usage.md` v4.0；v0.0.13 S3 描述里 D3.3 标注改为「v0.0.14 已激活」；已知 issue 段更新（accumulateUsage / assemble ratio / BUG-003 均更新为 v0.0.14 resolved）；新增「v0.0.14 落地状态」整段 |
| `specs/prd/overall/03-llm-chat.md` | version 1.3 → 1.4；§3.1 用户授权默认值「usage 不展示」补 v0.0.14 注（accumulateUsage 后端激活但前端 UI 仍独立决策）；§4 v0.0.13 已知 issue 段改写为 v0.0.14 已知 issue（accumulateUsage 已激活 + BUG-003 fixed） |

## 5. 工程欠债（未拆，本版本不涉及）

- `agent-loop.ts` 485 行（超 300 行红线）
- `session-state-machine.ts` 370 行（超 300 行红线）
- `session-store.ts` 432 行（超 300 行红线）

待后续版本拆分。

## 6. 验证产出

- UT：v0.0.14 维持 v0.0.13 基线绿。
- AT（真 LLM）：`session_usage_accumulate` 真 LLM PASS（ratio 学习收敛 ~0.6009 + session usage view 真聚合 + session_usage_update event 真发）。
- 产出位置：`states/v0.0.14/verify/`。
