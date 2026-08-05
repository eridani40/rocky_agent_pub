---
type: concept
title: Event Convention（topic + group 两级寻址约定）
priority: P0
status: active
updated: 2026-07-21
since: v0.0.8
---

# Event Convention

> event 体系的**约定规范**。transport 见 `[P0]event_bus.md`，路由见 `[P0]event_hub.md`。**所有业务 event 文档（agent_event / session_event / ...）遵循本约定**。

## 1. 两级寻址：topic + group

| 层级 | 含义 | 命名 | 例 |
|---|---|---|---|
| **topic** | 一级域（谁的事件流） | 固定域名词（snake_case） | `agent_loop` / `session` |
| **group** | topic 下的二级渠道（分区 + replay 单位） | `key_name:key_value`，多个下划线拼接 | `session_id:<sid>` |

- **group 在 topic 下唯一** → sub 必须 `(topic, group)` 双参。
- **无区分（广播）时 group = `"_all"`**：某 topic 若不按实例分区，group 统一用 `"_all"`（对齐代码先例：`SESSION_META_BROADCAST_GROUP` / `APP_TASK_BROADCAST_GROUP`，均定义于各自 event-types 模块）。

> 基础设施（event_bus / event_hub）**不感知业务**——topic / group 都是通用字符串，业务方自己编码含义。

## 2. 业务 event 文档规范（MANDATORY）

每个业务 event 文档**必须在开头声明**以下字段，明确该 event 在 event 体系中的位置：

| 字段 | 说明 | 例 |
|---|---|---|
| **依赖** | event_bus（transport）+ event_hub（路由） | event_bus / event_hub |
| **topic** | 一级域名 | `agent_loop` / `session` |
| **group** | 二级渠道（无区分用 `"_all"`） | `session_id:<sid>` |
| **producer** | 谁产出该 event（语义上拥有该 topic） | agent_loop / session 内部 |
| **bus 持有者** | 实际持有 EventBus 实例的组件（producer 通过它 emit） | agent_manager / session runtime |
| **Event 类型** | 该业务的 event 联合类型（本文档定义） | AgentEvent / SessionEvent |

> **topic owner ≠ bus 持有者**：topic 是业务域划分（谁的事件），bus 持有者是实现层（谁拥有 bus 实例）。例：agent event 的 topic owner 是 `agent_loop`，但 bus 实例由 `agent_manager` 持有（创建 AgentLoop 时注入）。

## 3. topic 清单

| topic | group | 流 | 文档 |
|---|---|---|---|
| `agent_loop` | `session_id:<sid>` | agent run 流式进度（token / tool_call / message_end / ...） | `../agent_interface_and_loop/[P0]agent_event.md` |
| `session_panel` | `session_id:<sid>` | session 面板 meta 变更（session_usage_update / ...） | `../session/[P0]session_event.md` |
| `session_meta` | `_all` | 会话列表 meta 广播（session_meta_update / ...，non-replayable） | `../session/[P0]session_event.md` |
| `app_task` | `_all` | consolidation task 状态广播（consolidation_task_update / ...，non-replayable） | `../session/[P0]session_event.md` |

> 后续新增 topic 在此登记。

## 4. 发布 / 订阅路径

```
（topic 的 bus 由 owner 创建时 registerTopic(topic, bus) 绑定到全局 hub；per-topic）
producer → bus.emit(group, event)                     // event_bus transport
消费者  → hub.sub(topic, group, listener)             // event_hub 按 topic 选 bus → bus.subscribe(group)
```

## 5. （版本史见 `log.md`）
