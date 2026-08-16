# Reminder 占比实测（rocky.log 单序列分析，2026-08-15）

- 数据源：`specs/research/cache_rate/rocky.log`（677KB，本 squad leader 会话 wire 请求，100 轮 / 199 messages / 总长 358,084 chars ≈ 89.5K tokens）
- 方法（老板口径）：单一请求 messages 序列 = 全历史；轮 k 的新增 = assistant[k]（上轮产出成为本轮输入）+ 到 assistant[k+1] 前的 user/tool 内容；历史轮 reminder 已被 protocol wire 层删除，用末轮 reminder 实测尺寸（4,498 chars ≈ 1,124 tok）近似每轮注入量
- 脚本：/tmp/remstudy2/analyze_log3.py（单 JSON raw_decode → assistant 分段 → 累计口径）

## 核心数字

| 口径 | 数值 |
|---|---|
| 每轮注入 reminder 体积 | ~4,498 chars ≈ **1,124 tokens** |
| **reminder / 每轮新增输入** | **72%**（末 30 轮均值；小轮接近 100%） |
| 每轮新增 / 请求总量 | 1.9%（缓存全命中时非缓存付费就这么大） |
| reminder / 请求总量 | 1.4% |

## 解读

1. **每轮新增 ~5K chars 里七成是 reminder**。真实新增（用户消息 + 工具结果）平均只占 28%；轮均新增 <500 chars 的小轮，reminder 占比接近 100%——reminder 比用户真实输入还大。
2. reminder 大头：todo 列表 + squad:agents 状态（19 成员）+ squad:tasks（16 任务）——**每轮全量重发**。
3. wire 序列实测验证了 protocol 删历史 reminder 的行为正常（非末条消息里 `[system_reminder]` 计数为 0），但删除不省钱——删除发生在发送前，末轮 reminder 仍在非缓存段。

## 358（KV 增量）ROI 推论

形态 X 落地后每轮只发变化 key：time 每轮必变（~100 tok），todo/squad 状态偶发变化。常态下 1,124 tok → ~150 tok，**非缓存 reminder 支出可省 ~85%**；每轮新增中 reminder 占比从 72% 降至 ~10%。

## 交叉验证

- langfuse 线（researcher 拉 prod traces）因 doom_loop 中断，本地 wire 日志口径已足够；两口径可后续互核。
