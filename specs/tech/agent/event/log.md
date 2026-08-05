---
type: log
title: Event KB 变更记录
updated: 2026-07-22
---

# Event KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-22 · v0.0.190

- **`event_bus.md` §2.2/§4.3 删 `opts.skipReplayHistory`**：AT record/replay 机制整体删除（见 `../../testing/at-framework.md` §5），该 opt 唯一用途（replay 轮跳陈旧 sticky）随之消失——`subscribe<T>(group)` 还原无 opts 签名；`EventBusLike.subscribe` / `EventHub.sub` 的 opts 透传同步删（impl 不再接受 opts 后的僵尸参数）。影响代码：`event-bus.ts`（删 opts 参数 + `!opts?.skipReplayHistory` 守卫）+ `event-hub.ts`（sub 不再透传 opts）。replayable sticky/buffer 回放语义保留（prod 业务依赖）。
- **代码-spec 一致核实（doc-modifier 阶段 5）**：`event-bus.ts` subscribe 无 opts + `if (this.replayable)` 无守卫 与 §2.2/§5 一致；`event-hub.ts` sub 无 opts 透传。无偏离。

## 2026-07-14 · v0.0.141.see_img

- **`event_bus.md` §2.2/§4.3 `subscribe` 加 `opts.skipReplayHistory`**：`subscribe<T>(group, opts?: { skipReplayHistory?: boolean })`——`true` 跳过本次 sticky+buffer 历史回放（仍订阅未来 emit），bus 只承载通用 boolean 开关不感知语义。唯一用途 = AT record→replay 双关同进程复用同一 sid group key 时，replay 轮不该回放上一轮真实 run 的陈旧 sticky（run_start/run_end）——门控在 `SseChannel.subscribe()`（test+replay 双条件才传），生产恒不传（零回归）。机制权威 `../../testing/record-replay.md §9.1`。影响代码：`event-bus.ts:137/148`（新增可选参数 + `!opts?.skipReplayHistory` 守卫）+ `event-hub.ts`（`sub` 透传 opts）。
- **代码-spec 一致核实（doc-modifier 阶段 5）**：`event-bus.ts:148` `if (this.replayable && !opts?.skipReplayHistory)` 与 §2.2/§4.3 描述一致；`event-hub.ts` `sub(topic, group, listener, opts)` 纯转发，hub 不解释语义。

## 2026-07-01 · v0.0.42

- **[T1 修复] sticky-exclusive（命中事件不进 buffer）**：`event_bus.md` §2.2/§4.3/§5 修正「sticky 是 buffer 镜像投影 / 同时写 buffer」的措辞为「sticky-exclusive：predicate 命中事件只写 sticky slot、不进 content buffer」。背景：原双写让 subscribe（先 sticky 后 buffer）把 run_start 回放两次 → AT `sse_subscribe_tc1` 回归 fail。代码同步改 `event-bus.ts emit`：buffer.push 移入 else 分支（仅非命中事件进 buffer）。
- `event_bus.md` §2.1 `EventBusOptions` 加 `lifecyclePredicate?: (event) => boolean`（实例级配置，识别生命周期标记）。
- `event_bus.md` §2.2 `clearReplay` 语义补：配了 predicate 时只清 content buffer、不清 sticky slot。
- `event_bus.md` §4.3 新增 sticky slot 行为（独立 slot、emit 时按 type 替换、run_start replace 语义、subscribe 先回放 sticky 再 buffer）；§5 伪代码同步加 sticky Map + run_start 清旧逻辑；§6 应用层说明补「agent_loop topic 注入 predicate 让生命周期标记粘住」。
- `index.md` ④核心设计原则 加第 6 条「replay 粘住生命周期标记」。
- 影响代码：`app/server/src/agent/event-bus.ts`（加 lifecyclePredicate + sticky Map）、`app/server/src/bootstrap.ts`（agent_loop bus 注入 predicate 识别 run_start/run_end）。

详情：`specs/tech/version_logs/v0.0.42/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`。
- 3 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理顶部 `> version:` blockquote + 尾部 `## 版本` 段，版本史迁移到本 log；保留正文内说明当前行为 rationale 的 drift 注。

## 2026-06-12 · v0.0.10

- `event_hub.md` §3 cancel 实现改 `bus.wakePendingSubscribers(group)`（替代 `bus.emit` 哨兵事件，避免污染 replayable buffer）；EventBus 最小依赖接口相应新增 `wakePendingSubscribers`。
- hub 级 (topic,group) 去重明确（impl 对同 (topic,group) 复用同一消费循环 + `activeSubs`）。

详情：`specs/tech/version_logs/v0.0.10/change_log.md`

## 2026-06-10 · v0.0.8

- event 子系统从旧 `message_hub` 更名迁 `event/`：`EventBus`（channel→group）+ `EventHub`（全局 singleton + `Map<topic, EventBus>` per-topic 路由）。
- topic+group 两级寻址规范成文（`event_convention.md`）；业务 event 文档声明模板（依赖/topic/group/producer/bus 持有者/Event 类型）。
- replayable bus + `clearReplay` 收紧窗口语义（agent_loop 每次持久化后清）。

详情：`specs/tech/version_logs/v0.0.8/change_log.md`
