---
name: performance-log-analysis
description: performance.log+cpuprofile 性能根因分析工作流
source: agent
production_method: consolidation
evolvable: true
updated: '2026-08-07T00:29:46.052Z'
---
# performance-log-analysis — Rocky 性能日志 + cpuprofile 根因分析工作流

## 何时用
老板说「看一下 performance log / data dir logs」、怀疑事件循环卡顿（hang）、慢查询（slowquery）、CPU/IO 尖峰时。一次完整分析 = 日志分类 + cpuprofile 解析 + 源码对号 + 报告落 outputs。

## 数据源
- `~/.rocky_agent_prod/logs/performance.log`（JSONL，三类事件：`slowquery` / `hang`(enter+recover) / profile 落盘记录）
- `~/.rocky_agent_prod/profiles/{electron-main,server}-*.cpuprofile`（每次 hang 自动采样双进程，无 TTL 会无限堆积）
- `~/.rocky_agent_prod/logs/error.log`（错误模式，单独分析）

## 步骤
1. **读 performance.log 分类事件**：按 kind 聚类（slowquery 的 entity/ms/count；hang 的 lagMs/cpuUserMs/间隔规律）。hang 看 lagMs 档位 + cpuUserMs：cpuUser 高=CPU 密集，cpuUser 低=IO 等待型。间隔规律（如 ~1.5-2h 一次）指向定时轮询/心跳。
2. **挑最近一次 hang 的 cpuprofile 解析**（python 脚本）：
   - self-time 聚合：`nodes[].hitCount * interval`，按 `callFrame.functionName @ url:line` 聚合 topN——**93% 会是 (idle)**（profiler 窗口=lagMs），看非 idle 的干活函数
   - total-time 调用树：建 children 树 + memoized total（自身+后代），从 root 展开 total>阈值的分支——**找驱动入口**（HTTP handler / 定时器 / wiring）
3. **源码对号**：cpuprofile 里的 `xxx.js:行号` 对应 dist 编译产物，源码在 `app/server/src/**/*.ts`（同名 .ts）。grep 关键函数（如 collectAll/scanEntityDir）确认实现（是否同步 IO / 有无缓存索引）
4. **报告落 outputs/reports/performance-log-analysis-<date>.md**：TL;DR 表（问题/严重度/根因/证据）+ 数据概览 + 调用树实锤 + 根因代码段 + 优化建议按 ROI 排序（P0/P1/P2）

## 已验证的根因模式（v0.0.270 实证）
- **fs-store 慢查询+hang 同根因**：`fs-store.query → collectAll → scanEntityDir` 每次 readdir + 逐个 `readJsonFileSync` 同步读全量 JSON（零缓存零索引），session 1168 条=每次列表请求同步读 1168 文件；多请求并发 → 同步 IO 排队卡事件循环 2.1s
- **event-loop-monitor**：阈值 lagThresholdMs=1000 / sampleIntervalMs=1000，超阈值抓 inspector CPU profile（`captureCpuProfileViaInspector` 在 hang 后采样，profile 里能看到它自己）

## 陷阱
- 别被 (idle) 93% 误导——那是 profiler 采样窗口，看非 idle 的 fs IO / query 链
- hitCount self-time 会稀释，必须算 total-time 调用树找驱动入口
- cpuprofile 的 url 是 dist `.js`，对号源码要找 `src/` 同名 `.ts`
