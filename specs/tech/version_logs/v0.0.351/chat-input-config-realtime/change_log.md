# v0.0.351 change_log：会话运行中配置实时生效

> 需求：老板 2026-08-15 09:08 拍板方案 A——会话运行中可改 model/effort/approvalMode，每 iteration 边界重读 session 最新配置生效
> 契约：`specs/tech/version_logs/v0.0.351/chat-input-config-realtime/change_plan.md`（frozen，不改）
> 实现 commits：T1 `3a3faeb14`（后端刷新）· T1 done `93a149cc1` · vitest-oom-patch `6e6ded255` · T2 `5c181b9fe`（前端 picker）· T2 done `3b405164e`
> Review：T1 `6b9007362` PASSED · T2 `e5fbff0c1` PASSED（观察项 2 条，①已由本文档同步处置）
> AT：`chat_runtime_config_realtime` PASS 8/8 steps · ET：ET-1/ET-2 全 pass blocking=0

## 变更摘要（决策 → 实现）

| 决策 | 内容 | 实现核对 |
|---|---|---|
| D1 重读边界 | Prepare 后、callLLM 前 await 刷新，刷新后复查 aborted | ✅ run-react-loop.ts（L158-171：`if (spec.wireStore)` 内 `await refreshRuntimeConfig` + aborted 复查） |
| D2 可变字段 | providerId/modelId/effort/approvalMode 四件套 | ✅ loop-runtime-config.ts（83 行新文件） |
| D3 client 重建 | providerId+modelId 任一变才 `buildLlmClient`；不变保持引用稳定；`SessionConfig` 加 `providerId` | ✅ context-types.ts 加字段（两分支填充于 session-config.ts） |
| D4 显式优先 | 运行中改模型直接写 session，不走 resolveModelRoutingPlan | ✅（PUT /session/:id 既有路径；刷新只读 session 值） |
| D5 轻量刷新 | 不重跑 buildSessionConfigFromDeps（skills/tools/workdir/systemPrompt 不重建） | ✅ |
| D6 仅 main | runKind 门控；旁路 run 保持启动快照 | ✅（函数内 runKind!=='main' return + 调用点 wireStore 外层门控，见偏差①） |
| D7 前端开门控 | 三 picker `disabled={false}` | ✅ T2（component-chat-session-input.tsx 3 处 + UT 4 新用例） |
| D8 trace 顶部 model | 保留启动值不随动（逐轮 startGeneration 自动用新 model） | ✅（接受态，不补 updateTraceModel） |

## 实现偏差（以代码为准）

1. **deps 来源**：change_plan 草案签名 `refreshRuntimeConfig(spec, deps)` 外部注入 deps；实现从 spec 自取（`spec.wireStore` + `spec.config.appConfig/pluginManager`），外层 `if (spec.wireStore)` 门控（无 wireStore 的测试路径零开销跳过）。runKind 判定仍在函数内，语义等价。
2. **session 不存在**：静默 return（log warn，沿用旧 config）——review 知悉项，非 plan 明文。

## 知悉项（T1 review `6b9007362`）

- effort 覆盖：session.effort 为 undefined 时覆盖为 undefined，语义正确（session 字段可空）。
- session-config.ts 470 行超 300 行规约——知悉不拆（避免本版扩大面）。

## 测试结果

- **UT**：T1 后端全量 10728 绿 + tsc 0（review 复跑）；T2 chat-session-input 14/14 + 全量 10722/10722（2 failed 系环境无关 browser attach，已注记）。
- **vitest OOM 补丁**：全量 UT JS heap OOM → vitest.config.ts 限并发 worker（`6e6ded255`；`specs/tech/app/package/[P0]tool_chain.md` 已沉淀）。
- **AT**：`chat_runtime_config_realtime` **PASS**（2026-08-15 11:19；8/8 steps；oracle `.observations[] any .model == "deepseek-v4-pro"` 1/7 matched，实证运行中改配置下轮生效；修复链 commits：`2e22d03e9` case 新增 / `22ebd53cb` group current→main / `7e27d5671` 切 deepseek / `33d816aaa` providerId 用 data.id / `ec6842b4f` step05）。
- **ET**：ET-1/ET-2 全 pass，blocking=0。

## 关键文件

| 文件 | 变更 |
|---|---|
| `app/server/src/agent/loop-runtime-config.ts` | 新增 83 行：`refreshRuntimeConfig` + `RuntimeConfigRefreshDeps` |
| `app/server/src/agent/run-react-loop.ts` | +21：Prepare 后 callLLM 前刷新 + aborted 复查 |
| `app/server/src/agent/context-types.ts` | `SessionConfig` 加 `providerId: string` |
| `app/server/src/handlers/session-config.ts` | 两分支填充 providerId |
| `app/server/src/agent/__tests__/run-react-loop.test.ts` | +162（模型变/不变两路径） |
| `app/web/src/components/chat-page/component-chat-session-input.tsx` | 三 picker `disabled={false}` |
| `app/web/src/components/chat-page/__tests__/component-chat-session-input.test.tsx` | +130（运行中可编辑 4 用例） |
| `vitest.config.ts` | 限 worker 防 OOM |
| `tests/api/cases/chat_runtime_config_realtime/` | AT case（messages+poll 造 running 窗口 + 四改 + Langfuse oracle） |

## 文档同步清单（doc-modifier，本 commit）

| 文档 | 变更 |
|---|---|
| `specs/api/overall/04-agent-session.md` | 6 处滞后措辞修正：SSE group `_amt:current`→`_amt:main` ×4（run 进度 / 帧示例 / SubscribeBody 注 / session_panel 注）+ usage `modeKey=current 累加`→`runKind=main`（响应键名 current 为对外契约不改）+ clear `modeKey="current"`→`runKind="main"`（对齐 v0.0.204 rename 与代码实际 group；L715 modeKey 字段名 defer 注保留） |
| `specs/api/overall/04a-session-chrome.md` | §5 补「运行中可改 + 下轮生效」（v0.0.351 refreshRuntimeConfig，旁路保持快照） |
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md` | §1 阶段 3 补 refreshRuntimeConfig 步骤（仅 main run） |
| `specs/tech/agent/agent_interface_and_loop/log.md` | 加 2026-08-15 · v0.0.351 条目 |
| `specs/ui/components/chat-page/component-input-model-picker.md` | disabled 语义现状（v0.0.351 运行中可编辑，下轮 iteration 生效） |
| `specs/ui/components/chat-page/component-input-effort-picker.md` | 同上 + 消费方注（use-chat-chrome / manage-tab 仅 import 类型不渲染） |
| `specs/ui/components/chat-page/component-input-approval-mode-picker.md` | 同上 |

> T2 review 观察项①处置：组件 spec 已补 v0.0.351 边界（上表 3 picker spec）；三个 picker 源文件头注释（.tsx 内「session running 时 disabled」句）属代码注释，doc 纪律不碰产品代码，留待后续注释瘦身统一处理。
