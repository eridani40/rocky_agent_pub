---
type: index
title: Dev Logs 子系统总起
priority: P0
updated: 2026-08-05
---

# Dev Logs 子系统总起

## ① 是什么

dev 调试日志（opt-in，文件落盘）：app_config `logs` group 7 个 boolean 开关背后的 **LogWriter 模块**（结构化记录 JSONL 追加写 `<DATA_DIR>/logs/*.log`，经 **LogQueue 有界消费者队列**异步批聚合落盘）+ **7 个 hook 点契约**（LLM 调用 / 工具执行 / 入站 HTTP / event emit / agent loop breadcrumb / run 错误 / 慢查询 的注入位置 + 捕获字段 + 零成本门禁）。

| 核心概念 | 一句话 |
|---|---|
| **LogWriter** | JSONL 写模块，每类日志一个 `<type>.log`（`LogType='llm'\|'tool'\|'api'\|'event'\|'error'\|'agent'\|'performance'`）；write 同步 stringify → enqueue |
| **LogQueue** | LogWriter 内部**有界消费者队列**：500MB byte buffer + drop-new（FIFO 丢新保老）+ 单 consumer async loop 批聚合 appendFile + 批间 `await sleep` yield 不阻塞 event loop |
| **日志轮转** | 每 type 独立 size-based 轮转：单文件 50MB 触发切片（rename `<type>.log`→`<type>-YYYYMMDD-HHMMSS-mmm.log`），每类最多保留 10 个（FIFO 删最老） |
| **logs group** | app_config 7 boolean 开关（llm/tool/api/event/error/agent/performance），默认 false |
| **7 hook 点** | llm 调用 / 工具执行 / 入站 HTTP / event emit / agent loop breadcrumb（诊断 hang）/ run 错误 / 慢查询（persistence query 超 200ms）+ 卡顿 episode（event-loop-monitor enter/recover） 的注入位置契约；performance.log 收后两类（kind 区分） |
| **零成本门禁** | `LogWriter.write` 内部 `?? false` 早 return，开关关时零开销（不 stringify、不 enqueue） |

## ② 边界

| 管 | 不管（→ 别处） |
|---|---|
| LogWriter 模块 + LogQueue 有界队列 + 7 hook 点契约 | 开关 schema（→ `../config/[P0]app_config.md §3.8`）|
| JSONL 落盘格式 + 按 type size-based 文件轮转 | HTTP facade（→ `specs/api`）/ UI（→ `specs/ui`）|
| opt-in 门禁 | truncate 体内容 / 控制台输出 / 跨进程聚合（不在范围）|

## ③ 与系统的关系

```
   app_config.logs(7 开关) ──门禁──→ LogWriter.write（同步 stringify）
                                          ↓ enqueue（O(1) 入队）         ↑ 7 hook 点注入（llm/tool/api/event/agent/error/performance）
                                   LogQueue（500MB drop-new + 单 consumer async loop + 批聚合 appendFile）
                                          ↓ 按 type 分桶 + 写前轮转检查
                                   <DATA_DIR>/logs/<type>.log（JSONL；活跃文件恒此名，轮转切到 <type>-<ts>.log）
```

底经 persistence（`<DATA_DIR>` 来自 ENV，不读 config 避免循环）；event hook 用 bus proxy 拦截 emit（不改散落 emit 调用点）；performance hook 反向——persistence（slow-query）与 observability（hang-sink）两个底座各自暴露模块级 sink 注册点，由 bootstrap 注入 LogWriter 适配（保上层→底座单向依赖）；performance.log 收两种记录靠 `kind` 字段区分（`'slowquery'` / `'hang'`）。

## ⑤ 本目录导航

| 文档 | 管什么 | 链接 |
|---|---|---|
| `overall.md` | LogWriter + LogQueue + 7 hook 点契约 + 文件轮转（全文） | [link]([P0]overall.md) |

> 变更见 `log.md`；跨版本发布说明见 `../version_logs/vX.Y/change_log.md`。
