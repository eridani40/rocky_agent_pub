---
type: index
title: Event 子系统总起（通用 pub-sub 基础设施）
priority: P0
updated: 2026-07-01
---

# Event 子系统总起（通用 pub-sub 基础设施）

## ① 是什么

event 子系统 = **与业务无关的通用发布-订阅底座**——`EventBus`（transport，按 group 分区 + 可选 replay buffer）+ `EventHub`（全局 singleton 路由表，按 topic 选 bus）。session/agent/... 各业务域**自带** topic + group 含义（见 `event_convention.md`），本子系统只认字符串、不解析内容。

| 核心概念 | 一句话 |
|---|---|
| **EventBus** | transport 实例：按 group 分区 + 可选 replay buffer（per-instance `replayable`）；`emit/subscribe/clearReplay` |
| **EventHub** | 全局 singleton 路由表 `Map<topic, EventBus>`：订阅方给 `(topic, group)` 即可，不持有 bus 实例 |
| **topic** | 一级域（业务域名词：`agent_loop` / `session_panel`），选 bus 实例（per-topic 一 bus） |
| **group** | topic 下的二级渠道（`session_id:<sid>`），bus 内分区 + replay 单位 |
| **replay buffer** | replayable bus 的有限窗口 buffer：只含「上次 `clearReplay` 之后 emit 的」事件（非全量历史） |
| **registerTopic** | owner 创建 bus 后注册到 hub：`hub.registerTopic(topic, bus)`（重复注册幂等覆盖） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| EventBus transport（emit/subscribe/clearReplay/wakePendingSubscribers） | 业务 event 联合类型（AgentEvent → `../agent_interface_and_loop/[P0]agent_event.md`；SessionEvent → `../session/[P0]session_event.md`） |
| EventHub singleton 路由（`Map<topic, EventBus>` + registerTopic/sub/unsub） | topic 的业务语义（谁产谁消费 → 各业务 event 文档声明） |
| topic + group 两级寻址**约定规范**（`event_convention.md`） | 持久化 / 查询接口（历史由各 store 负责，replay 只补「持久化点→当前」空窗） |
| per-topic bus 实例模型 + group 分区 + replay buffer 行为 | SSE channel / 前端消费（→ UI 层） |

## ③ 与系统的关系

```
                        ┌── EventBus (agent_loop topic, replayable)   ← owner: agent_manager
                        │     group = session_id:<sid>_amt:<modeKey>
   event KB             │
   (本目录) ────────────┤
                        ├── EventBus (session_panel topic)            ← owner: session runtime
                        │     group = session_id:<sid>
                        │
                        └── event_convention.md（topic+group 规范 + 业务 event 文档声明模板）

消费方统一入口：hub.sub(topic, group, listener) → hub 按 topic 选 bus → bus.subscribe(group) → unwrap data
生产方：bus.emit(group, { data, timestamp })（bus 层用 group；hub 层用 (topic, group)）
```

**对外协作点**：
- `EventHub.singleton()` 系统启动时建（全生命周期一个）。
- 每个 topic 的 owner 在启动时 `new EventBus({replayable})` + `hub.registerTopic(topic, bus)`：`agent_loop` topic → `app/server/src/agent/agent-manager.ts`；`session_panel` topic → session runtime。
- 落地代码：`app/server/src/agent/event-bus.ts`（`ReplayableEventBus`）+ `app/server/src/agent/event-hub.ts`（`EventHub` singleton）。

## ④ 核心设计原则（跨文件不变量）

1. **bus 实例 per-topic**——每 topic 一个 bus（独立 replay buffer / 订阅者集合），bus 内按 group 分区；非「一个全局 bus」。→ `event_bus.md §6`
2. **hub 去耦订阅方与 bus 实例**——订阅方只给 `(topic, group)`，hub 找 topic 的 bus → `bus.subscribe(group)`；无 hub 则订阅方需持有 bus 实例。→ `event_hub.md §1`
3. **replay 是有限窗口不是全量历史**——buffer 由业务方 `clearReplay`（持久化点）收紧为「未持久化半截」；历史靠各 store 查询接口。→ `event_bus.md §1/§4`
4. **hub 层 (topic,group) 去重 ≠ bus 层 fan-out**——同 (topic,group) 复用单条消费循环；bus 层多订阅者仍 fan-out。→ `event_hub.md §3`
5. **基础设施不感知业务**——topic / group 都是通用字符串，业务方自己编码含义（`key_name:key_value`）。→ `event_convention.md §1`
6. **[v0.0.42] replay 粘住生命周期标记（sticky-exclusive）**——`clearReplay` 只清 content 增量、不清生命周期标记（`run_start`/`run_end`），保证切走切回 run 状态可恢复。靠 bus 实例级 `lifecyclePredicate` 配置注入（仅 agent_loop topic 启用；其他 topic 不传 = 旧行为零回归）。sticky slot **独立于** content buffer——命中 predicate 的事件**只写 sticky slot、不进 content buffer**（避免 subscribe 先回放 sticky 再回放 buffer 时把同一事件回放两次 → run_start 重复），由 emit 维护、clearReplay 不动、subscribe 先回放。→ `event_bus.md §2.1/§4.3/§6`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **transport** | | |
| `event_bus.md` | EventBus 接口（emit/subscribe/clearReplay）+ replayable buffer 行为 + per-topic 实例模型 | [link]([P0]event_bus.md) |
| **路由** | | |
| `event_hub.md` | EventHub 全局 singleton + `Map<topic, EventBus>` 路由 + registerTopic/sub/unsub | [link]([P0]event_hub.md) |
| **规范** | | |
| `event_convention.md` | topic+group 两级寻址约定 + 业务 event 文档声明模板 + topic 清单 | [link]([P0]event_convention.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
