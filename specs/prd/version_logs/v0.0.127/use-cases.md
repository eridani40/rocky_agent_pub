# v0.0.127 — E2E Use Cases

> 附属于 `change_log.md` §8。因本版本是测试基建重构，Use Cases 描述 **designer / executor / coder 在新框架下的操作链路**（非终端用户操作）。

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | designer 读组件 spec 取 testid → 写 case.yaml（navigate + click + check）→ executor 跑 run_all | case pass（dom 断言全绿）+ per-step 产物落盘 |
| UC-2 | designer 写含 SSE 的 case（sse.sub + check count run_stop）→ record 轮真跑录帧 → replay 轮保真回放 | 两轮全绿；sse.jsonl 帧序列按时序回放，UI 渲染行为与真跑一致 |
| UC-3 | designer 迁移旧 `js:fetch+轮询` case → 拆为 requests + wait/poll + check → 跑 run_all | 新 case 语义等价旧 case，pass 且无显式 sleep |
| UC-4 | designer 写含设计稿的 case（compares[]）→ run_all 自动截设计稿 + 跑 vision_check compare | 逐维度 PASS（layout/font/border/color）或建 BUG |
| UC-5 | coder 改框架代码 → 跑 selftest → 全绿才提交 | selftest 兜底框架改动（不依赖 case） |
| UC-6 | ET case 漏声明 stub（`stub:[http]` 缺失）→ record 轮该 step `hit_not_declared` | fail + 自解释「step N 命中 http 通道但未声明」 |
| UC-7 | replay 轮录制过时（API schema 变）→ 命中 `recording_drift` | drift 单列计数不翻 overall；orchestrator 安排重录 |
| UC-8 | executor 跑 `ET_REPLAY_FAST=1 bash tests/e2e/lib/run_all.sh` | 帧不 sleep 一次性 write；快速 smoke 通过 |
| UC-9 | replay 轮某 API 未匹配录制（`UndeclaredStubError`）→ case fail | fail + 自解释「api_normalized=POST /session/*/messages seq=2 无录制」 |
| UC-10 | designer 合并 approval allow+deny（双 session 并行）→ setup 建 2 session + 两路断言 | 合并后单 case 覆盖双路径，pass |
| UC-11 | record 轮 PASS → 自动紧接 replay 轮 → 两轮全绿才落盘 recordings/ | 双关验收；FAIL 绝不落盘（含 frame_checks fail 删新录制） |
