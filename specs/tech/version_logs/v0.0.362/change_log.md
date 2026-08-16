# v0.0.362 change_log — run-end 汇报去重（最近 3 轮 send_message→leader 命中则跳过 mate 退出通知）

> 需求：老板 2026-08-15 20:29 拍板（`reqs/[working] v0.0.362.run-end-report-dedup.md`，commit 4866c85b7）。
> 权威契约：`specs/tech/version_logs/v0.0.362/change_plan.md`（frozen，§1.1 插入点 + §1.2 窗口数据源 + §1.3 三形态口径）。
> commit：`9c3bc9aca`（架构四件套）/ `f3b336a91`（T1 实现）/ `c621d4f3d`（states T1 done）/ `6811eec48`（review PASS）。
> 纯内部行为无 UI 感知 → 跳 PRD。

## 变更摘要

mate run 退出通知 leader 的兜底 hook（v0.0.273）在 mate 已主动 send_message→leader 汇报后仍投递「run 已结束」通知 → leader 收到重复信息。本版在 `notifyMateExit` 内加去重判定：最近 3 轮 assistant message 内已有 send_message→leader 调用 → 认定已汇报过，跳过本次投递。

| 决策 | 内容 |
|---|---|
| ① 简单粗暴口径 | 只看 tool_use 存在性，不区分 needReply/发送成败（老板拍板；失败发送也命中——「已汇报」按调用存在性认定） |
| ② 末轮伪消息补拼 | run 最终 assistant 回复不在 snapshot 内（snapshot 是 LLM 输入侧）→ `lastAssistantContent` 非空时拼为伪 assistant message，否则最常见的末轮汇报永不命中 |
| ③ target 三形态 | `'parent'`（mate 的 parent 即 leader）直命中 / 显式 sessionId `=== leaderSid` / AgentRef `sessionId === leaderSid` |
| ④ name 形态不解析 | AgentRef `{name:'Darvin'}` 形态不做 store 解析比对——避免每条 tool_call 异步解析，违背「简单粗暴」拍板（已知限制） |
| ⑤ 插入点 | `notifyMateExit` 内、leaderSid 两跳解析成功后、消息构造前——onRunEnd/onInterrupted 两调用路径天然同享；未命中路径逐字节不变 |

## 实现核对（T1）

| 计划项 | 实现一致性 |
|---|---|
| hasRecentLeaderReport 纯函数 | ✅ `mate-exit-notify.ts` 导出（零 IO，与 truncateText/formatMateExitNotify 同层）：snapshot.messages 过滤 assistant + lastAssistantContent 伪消息追加 → `slice(-window)`（window=3 缺省）→ 扫 tool_call（name==='send_message' && target 三形态） |
| snapshot null 防御 | ✅ `!snapshotMessages → return false`（理论不达，未命中照发） |
| notifyMateExit 接线 | ✅ leaderSid 解析后调用；命中 `console.log('[mateExitNotify] recent send_message to leader found, skip run-end report (dedup)')` + return |
| MUST NOT 守住 | ✅ formatMateExitNotify/退出原因分类/汇报格式零改动；leader 解析失败/squad 缺失等短路路径不变（判定在其后） |
| UT（+92） | ✅ 命中三形态（parent/显式 sid/AgentRef）+ 未命中（无 send_message/target 指向他人）+ 窗口边界（命中调用在第 4 轮→不命中）+ lastAssistantContent 伪消息参与 + snapshot null |

## 实现偏差（以代码为准）

无表内偏差。review（`6811eec48` PASS）独立复核：伪消息重复计数疑虑实证不成立（lastAssistantContent 仅 callLLM 后写、snapshot 仅 prepareStage assemble（LLM 前），末轮永不进 snapshot；no_new/interrupted/tool_pending 各终态逐一核过）；target 三形态判定/插入点/未命中路径逐字节不变/文件清单==coversFiles 均核过。

## 已知限制（req 范围外，接受）

1. name 形态 AgentRef（如 `{type:'agent', name:'Darvin'}`）不解析——该形态 send_message 不命中去重，退出通知照发（宁多发不漏发）。
2. 窗口内 send_message 失败（deliverTo 抛错被内部 catch）仍命中跳过——「已汇报」按调用存在性口径（老板拍板）。
3. 窗口内发给 leader 的内容若与 run 结尾状态无关（如中途问询）也命中跳过——窗口仅 3 轮 + mate 尾部惯例是交付汇报，误杀面小，接受。

## 验证

UT 必须（已跑）：定向 28/28 + 全量 10854 passed + tsc -b 0 error（reviewer 独立复跑）。AT/ET 豁免（纯内部行为，无 API/UI 变化）。

## API 面核对（doc-modifier 确认）

`specs/api/` grep「退出通知 / mateExit / mate_exit / mate-exit」零命中——mate 退出通知是 agent 内部投递（deliverTo），不经 HTTP 端点、无 SSE 事件格式定义；本改动零 IO、不动消息格式（Message 信封 sender.source='agent' + needReply:false 仿 send-message-tool 原样）。**API 面无变化，无需 api spec 同步。**

## 关键文件

| 文件 | 变更 |
|---|---|
| `app/server/src/agent/mate-exit-notify.ts` | hasRecentLeaderReport 纯函数（+43）+ notifyMateExit 去重接线（+6） |
| `app/server/src/agent/__tests__/mate-exit-notify.test.ts` | describe hasRecentLeaderReport（+92） |

## 文档同步（doc-modifier，本版本）

- **`specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md` §3.2**：mateExitNotify 装配段投递形态句后补「run-end 汇报去重」语义句（判定点/窗口构造/三形态/已知限制）——现行 mate-exit-notify 机制语义权威在此段（change_plan §3 原估归 a2a_protocol，实际 grep 该 KB 零命中，按现状落点）。
- **`specs/tech/agent/agent_interface_and_loop/log.md`**：加 v0.0.362 变更块（KB 位置轴）。
- **api spec**：零改动（见上「API 面核对」）。
