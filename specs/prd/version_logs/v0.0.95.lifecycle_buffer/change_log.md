# v0.0.95 useLifecycle buffer 第三参数 — PRD

> version: 1.0 · 引入版本 v0.0.95.lifecycle_buffer · 类型：**纯架构重构（契约补全），不加任何新用户功能** · 最后更新：2026-07-08
> 权威输入：`reqs/[done] v0.0.95.lifecycle_buffer/req.md`（用户拍板的设计约束，是本 PRD 的**法律**——buffer=map/单实例/onEvent 串行/D1 参数传递/D2 buffer 用完清理）
> 概念权威源（本 PRD 必须对齐，不发明概念）：`specs/tech/app/frontend/[P0]component_architecture.md §3.10`（useLifecycle 四方法 + ①ref-latest 不变量 + mutate 口子）+ `[P0]lifecycle_data_shapes.md`（三形 + §3.2 流式特例说明）+ `[P0]chat_area_hooks.md §3`（useMessages 流式特例现状，含 v0.0.95 预告）
> **本 PRD 不新增 §3 功能章节**（无用户可感知新功能，符合 prd-spec-rules §增量更新规则「内部重构可简化」）。核心价值 = 定义「buffer 契约」+「useMessages 进契约后流式不回归」+「为什么补这层」。全量 §3 功能定义仍在 `specs/prd/overall/03-llm-chat.md`（Playground）+ `08-squad-studio.md`（Studio），本次不改其功能语义。

## 目录

| 章节 | 文件 | 说明 |
|------|------|------|
| §1 目标 + 动机 | 本文 | 补 v0.0.94 gap：消灭 useMessages 唯一特例；buffer = reducer 私有工作内存 |
| §2 范围 | 本文 | useLifecycle 加 buffer 第三参数 + reducer 纯化 + useMessages 进契约；可选修 BUG-001 |
| §3 关键用户路径（MANDATORY） | [1-key-user-paths.md](1-key-user-paths.md) | 纯架构版路径 = 现有流式不回归 = 回归测试最低覆盖契约 |
| §4 PRD ↔ ui/tech spec 对齐核对 | [2-spec-alignment.md](2-spec-alignment.md) | 引用 v0.0.94 概念一致性核对 + 开放点交 architect |
| §5 验收标准 | [3-acceptance.md](3-acceptance.md) | 契约 100% 覆盖 + reducer 纯化 + buffer 不渲染 + 流式不回归 |

---

## 1. 目标 + 动机

### 1.1 核心目标：消灭 useMessages 唯一特例，契约 100% 覆盖

v0.0.94 已把所有数据 hook 统一到 useLifecycle 四方法契约（design-decisions §1）+ 数据三形（Collection / Snapshot / KeyedMap）+ ①ref-latest 不变量。**唯一例外是 `useMessages`**——它是 v0.0.94 唯一不进契约纯函数通道的 hook（`[P0]chat_area_hooks.md §3` 显式标「流式特例」+ `[P0]lifecycle_data_shapes.md §3.2` 标「三形之外的第四类」）。

根因（`[P0]chat_area_hooks.md §3` + 现状代码 `use-messages.ts`）：agent_loop 帧是 **part 级碎片**（`text_delta` / `tool_call_delta`），单帧 event 不足以渲染——reducer 需要全量 `messages` 做基底 + **跨帧累积半成品**（`tool_call_delta` 的 rawArgs 半截 JSON、`pendingError` 跨帧缓存、messageId 映射）。这部分累积态既不属于 ctx（已渲染存量，会触发渲染），也不属于三形（不是整对象 upsert）。

现状 `applyAgentEventToMessages` 通过 **mutate 外部 `ctxRef: {current: RunContext|null}`** 累积（`chat-slice-reducer.ts:103-108`）——这是**副作用**，违反三形「纯函数 immutable」前提 → reducer 不进契约纯函数通道 → `useMessages` 自管 `sliceRef + runCtxRef + setSlice`（`use-messages.ts:77-85`），与 `useSessionPanelFanout` 一样「借 useLifecycle 管订阅、onEvent 副作用写 ref」。

**v0.0.95 给 useLifecycle 加 buffer 第三参数**，把这个隐式累积态正名为契约一等公民：reducer 收 `buffer` 参数（reducer 私有工作内存）→ return 新 `{ctx, buffer}` → 进契约纯函数通道 → useMessages 进契约，特例消灭。

### 1.2 buffer 的语义（区别于 ctx）

| | ctx（v0.0.94 已有） | buffer（v0.0.95 新增） |
|---|---|---|
| 含义 | **已渲染存量**（用户能看到的） | **reducer 私有工作内存**（未渲染累积态） |
| 变化触发 | 变 → setCtx → 渲染 | 变 → bufferRef 更新，**不渲染** |
| useMessages 例 | `{messages, runActive, loadingPhase, lastRunFinish, enqueueItems}` | `{rawArgs: Record<id,string>, pendingError, idMap}` |
| 典型内容 | 完整 message / 状态字段 | 半截 JSON 片段、待提交 error、临时映射 |
| 清理时机 | 由 reducer / onEvent 自然更新 | **用完必须清理**（D2） |

buffer 不是「第二个 ctx」——它是 reducer 工作内存的契约化容器，让 reducer 把「跨帧累积副作用」变成「返回新 buffer 的纯函数」。普通 hook（列表 / 标量 / 红点）**不需要 buffer**，buffer 恒为 null 或忽略（不变量）。

### 1.3 明确不加新功能（MANDATORY 边界）

**本版本零新用户功能、零新页面、零新交互、零 API 契约变更。** 用户能看到的一切（流式文字累积、工具调用参数渲染、消息清空、分页、群聊/单聊/playground 三页流式一致）在重构前后**行为完全一致**。唯一目标是补全 useLifecycle 契约的 buffer 维度，消灭唯一特例。

- BUG-001（chat_basic Tiptap 兼容债）**可选顺手修**（见 §2.3），不影响 buffer 主线。
- 不碰 SSE 基建、不碰后端、不碰三形 reducer（Collection/Snapshot/KeyedMap 不变）。

---

## 2. 范围

### 2.1 三件事（req.md 工作量预估对齐）

1. **useLifecycle 加 buffer 第三参数**（T1）：`useLifecycle<TCtx, TBuffer, TEvent>` 泛型加 `TBuffer`；`onInit` 返 `{ctx, buffer}` 初值；`onEvent`/`onTick` 收当前最新 ctx+buffer 返新的；`onDestroy` 收 ctx + buffer（或 null）做清理；新增 `mutateBuffer(updater)` 命令式口子（与 `mutate` 平级，改工作内存不渲染）；调度保证 onEvent 串行（req 约束 3，单 buffer race 防护）；UT 覆盖。
2. **`applyAgentEventToMessages` 纯化 + useMessages 进契约**（T2，重点）：reducer 从 `mutate ctxRef` 改成 `return {ctx, buffer}`（ctx=新 messages+状态切片，buffer=新累积态）；半截 `rawArgs`/`pendingError` 进 buffer（不渲染）；攒够（tool_call 完成）写进 ctx.messages 时**同帧从 buffer 删 key**（D2）；`useMessages` 删除自管 `sliceRef`/`runCtxRef`，改用 useLifecycle 的 ctx + buffer 通道。**重点验证 rawArgs 累积语义不回归**（BUG-002 相关链路）。
3. **spec 同步**：`[P0]component_architecture.md §3.10` 加 buffer 参数说明；`[P0]chat_area_hooks.md §3` 删「流式特例 / v0.0.95 预告」改「标准契约 + buffer 范例」；`[P0]lifecycle_data_shapes.md §3.2` 同步标「v0.0.95 已进契约」。

### 2.2 明确不做（边界）

- **三形 reducer 不动**：`applyCrud` / `applySnapshot` / `applyKeyed` 保持纯函数 immutable（它们本就没有累积态，buffer 对它们恒 null）。
- **普通 hook 不强行用 buffer**：所有 list/snapshot/kv hook（17 个，v0.0.94 已迁）buffer 恒 null，签名上 `TBuffer = void | null` 或忽略——不增加普通 hook 心智负担（req 关键不变量）。
- **命令式方法不进 useLifecycle 回调**：`setMessages`（loadMore 分页，走 mergeMessagesById）+ `removeEnqueueItem` 仍是 hook 暴露的命令式方法，内部走 `mutateCtx`（改渲染态）/ `mutateBuffer`（改工作内存）口子，而非 useLifecycle 回调。
- **loadMore / 分页仍组件自管**（design-decisions §7，v0.0.94 沿用）。

### 2.3 可选修：BUG-001（chat_basic Tiptap 兼容债）

req.md 验证项提到「chat_basic_tc1 Tiptap 兼容（BUG-001，可一并修）」。**作为可选顺手修**，不强制纳入本版本主线（不阻塞 buffer 主线验收）。若修，需建 BUG-001 文件并走标准 bug 流程；若不修，留待后续版本。架构期由 architect + orchestrator 决定是否纳入。

---

## 3. 关键用户路径

见 [1-key-user-paths.md](1-key-user-paths.md)。这是本 PRD 的核心交付——纯架构版的路径 = **现有流式行为不回归** = 回归测试最低覆盖契约。重点覆盖 part 级累积相关的所有场景（文字 / 工具参数 / 多帧顺序 / 清空 / 分页 / 三页一致）。

## 4. PRD ↔ ui/tech spec 对齐核对

见 [2-spec-alignment.md](2-spec-alignment.md)。本版不发明新概念，buffer 是 v0.0.94 design-decisions §4「数据三形」+ `[P0]chat_area_hooks.md §3` v0.0.95 预告里隐含的「特例 reducer 工作内存」的**契约正名**。开放点（mutateCtx/mutateBuffer 是否分立、buffer 对外是否只读）交 architect 在架构期定。

## 5. 验收标准

见 [3-acceptance.md](3-acceptance.md)。
