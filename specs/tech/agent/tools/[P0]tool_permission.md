---
type: spec
title: Tool Permission — 策略层 + 审批层（checkPermission / PermissionDecision / ApprovalManager）
priority: P0
status: active
updated: 2026-07-15
since: v0.0.122
---

# Tool Permission — 策略层 + 审批层

> 工具执行安全三层的**前两层**（策略层 + 审批层）；第三层（执行层沙箱）见 `[P0]bash_tools.md §4`。
> 上游：`index.md`（Tool / execute / allowedTools）+ `[P0]tool_execution_engine.md §3/§5`（串行引擎 + interaction 分流）。
> 复用 infra：`../agent_interface_and_loop/[P0]agent_hitl.md`（pending 队列 / suspended / tool_reply 回填 / 同 id upsert，INV-1~7）。
> 首次引入 [v0.0.122]，范围=bash 工具。

## 1. 概念：策略层 + 审批层

工具执行安全在引擎串行 loop 内**新增一道正交门**（在 `allowedTools` 白名单门后、`interaction` 分流前）：

```
engine.execute() 串行 loop（每个 toolCall）
  ① allowedTools 白名单门（现有，engine.ts:109）
  ② checkPermission 策略门（【v0.0.122 新增】）
       allow ──────────────→ 继续 ③
       deny + reason ──────→ isError 结果（reason 回灌 LLM），不执行，不悬挂
       ask + reason + key ─→ ApprovalManager.isApproved(sessionId, key)?
                               已同意 → 视同 allow，继续 ③
                               否则 → 构造 need_approval ToolInteraction 走现有 pending 路径【审批层】
  ③ tool.interaction() 分流（现有，engine.ts:132）
  ④ tool.run()（现有）
```

**核心不变量 INV-P1（正交两门）**：`allowedTools`（tool_policy.md，能不能用这个工具）与 `checkPermission`（这次调用的参数安不安全）是**两道独立的门**，不替代、不合并。白名单先过、策略后过。

**核心不变量 INV-P2（钩子可选，缺省 allow）**：`checkPermission` 是 `Tool` 的可选钩子。未实现的工具视同 `allow`（现状行为完全不变，仅 bash 挂策略）。

**核心不变量 INV-P3（工具不管审批流程）**：工具的 `checkPermission` 只产出 `PermissionDecision`（纯判定，无副作用）。ask 时**由引擎**查 ApprovalManager + 构造 `need_approval` interaction；工具不感知悬挂/回填/审批卡。

## 2. PermissionDecision（决策三态）

落 `app/server/src/tools/types.ts`（与 `ToolInteraction` 并列）：

```typescript
export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; reason: string; approvalKey: string };
```

- `deny.reason` / `ask.reason`：人类可读拦截原因。deny 时进 isError 结果文本（LLM 可见）；ask 时进 `ApprovalData.reason`（审批卡展示）。
- `ask.approvalKey`：拦截原因的**稳定标识**，格式 `{toolName}:{policyId}`（如 `bash:rm-wildcard`）。「永远同意」按此 key 记忆（被拦截原因一致才免弹，§4）。

## 3. checkPermission 钩子契约

`Tool` 接口新增可选方法（`types.ts`）：

```typescript
checkPermission?(input: ToolInput, ctx: ToolCtx): PermissionDecision;
```

- **同步纯判定**（对齐 `interaction` 幂等纯读语义）：只读 `input`，不改外部状态、不发起 IO；引擎可能在一次 execute 内调用一次。
- **返回 allow** = 无异议（等价未实现）。
- **抛错兜底**：checkPermission 抛异常，引擎视作 `allow`（fail-open，避免权限检查异常阻断正常工具；与 interaction 抛错降级 run 同风格）。安全兜底由执行层沙箱（§bash_tools §4）承接。

## 4. 引擎集成（engine.ts execute 精确位置与顺序）

在 `ToolExecutionEngine.execute()` 串行 loop 内，位置**在 `resolveTool` + `validateInput` 通过后、`tool.interaction` 调用前**（engine.ts 现 L126 注释「HITL 钩子」之前插入）：

```
for (const call of toolCalls) {
  // L109 allowedTools 白名单门（现有）
  // L115 resolveTool（现有）
  // L121 validateInput（现有）
  const ctx = { config, workdir, readSet } // 现有 L127-131 构造
  // ★ 策略门（在 interaction 之前；INV-P1：位于白名单门后）
  if (tool.checkPermission) {
    const decision = safeCheckPermission(tool, call.arguments, ctx) // try/catch → allow
    if (decision.behavior === 'deny') {
      results.push(wrap(call, errorResult(decision.reason))) // isError=true, 不执行
      continue
    }
    if (decision.behavior === 'ask') {
      // 绿灯短路（approvalMode='greenlight'）—— session 级总开关，ask 视同 allow fall through。
      // 安全 invariants 不动：deny 分支（上方）在其之前天然不被绕过；执行层沙箱不受影响。
      // 绿灯与 always（isApproved）正交：两者任一满足都 fall through。
      const isGreenlight = config.approvalMode === 'greenlight'
      if (!isGreenlight
          && !await approvalManager.isApproved(config.sessionId, decision.approvalKey)) {
        // 构造 need_approval interaction，复用现有 pending 路径（不新造分支）
        const interaction = buildApprovalInteraction(call, decision) // ToolInteraction{need_approval, approval, ApprovalData+reason+approvalKey}
        const { resultBlock, pendingCall } = buildPendingResult(call, interaction, config.sessionId, runId)
        results.push(resultBlock); pending.push(pendingCall); continue
      }
    }
    // ask + (绿灯 | 已 isApproved) → fall through 视同 allow
  }
  // L132 tool.interaction 分流（现有，不变）
  // L153 tool.run（现有，不变）
}
```

**关键约束**：
- **deny 走 isError 结果**（`errorResult(reason)` → wrap），**不悬挂**——LLM 下一轮看到拒绝理由自行调整（同 rejectToolCall 语义，但 reason 是策略原因非白名单）。**deny 分支位置在 ask 分支之前**——绿灯（`approvalMode='greenlight'`）在 ask 分支内短路，天然不绕过 deny。
- **ask 未同意走 `buildPendingResult`**（现有函数，不新造）——引擎把 `PermissionDecision.ask` 翻译成 `ToolInteraction{subType:'need_approval', handleType:'approval', data: ApprovalData}`，其余（占位 block / pending wrapper / ingest 回填 / setPendingToolCalls / emit require_human_input）全走 v0.0.101 既有链路。
- **ApprovalManager 注入引擎（构造注入 + 进程级单例缺省）**：`ToolExecutionEngine` 构造签名 `constructor(approvalManager?: ApprovalManager)`——缺省 = `approval-manager.ts` 导出的**进程级单例** `approvalManager`（bootstrap `new ToolExecutionEngine()` 零参即用该单例）；UT 可注入 fresh 实例保证隔离。`config.sessionId` 缺省时（forked）approvalManager 查询按空 sessionId 处理（forked loop 不涉及 HITL，实际不会走到 ask 悬挂）。bootstrap 在 SessionStore 就绪后调 `approvalManager.setStore(sessionStore)` 注入 ApprovalStorePort（v0.0.148 起持久化 backing，对齐 `contextEngine.setSessionStore` 模式）。
- **isApproved/recordAlways async（v0.0.148）**：cache miss 读 store 需 await，engine.execute + tool-reply-handler 两调用点 await（详见 §5 cache-through）。

**ApprovalData 扩展**（`types.ts`，向后兼容加 2 可选字段）：

```typescript
export interface ApprovalData {
  toolName: string;
  arguments: unknown;
  reason?: string;        // 【v0.0.122】ask.reason，审批卡展示拦截原因
  approvalKey?: string;   // 【v0.0.122】ask.approvalKey，allow_always 回填时 recordAlways 用
}
```

## 5. 审批层 — ApprovalManager 接口与生命周期

模块 `app/server/src/tools/approval-manager.ts`（cache-through + ApprovalStorePort 持久化）：

```typescript
/** 持久化端口（薄 2 方法，依赖倒置）。SessionStore 直接 implements 此 port。 */
export interface ApprovalStorePort {
  getAlwaysApprovedKeys(sid: string): Promise<string[]>;
  addAlwaysApprovedKey(sid: string, key: string): Promise<void>;
}

export class ApprovalManager {
  /** sessionId → 已「永远同意」的 approvalKey 集合（**cache**，随进程生命周期） */
  private map = new Map<string, Set<string>>();
  /** 持久化端口（post-bootstrap 注入；缺省 undefined = UT 隔离 / 无持久化） */
  private store?: ApprovalStorePort;
  /** 注入端口（非构造函数注入：ApprovalManager 单例先于 SessionStore 就绪） */
  setStore(port: ApprovalStorePort): void;
  /** cache hit → 直接判定；cache miss + store wired → 读 store 填 cache 后判定；无 store → false（UT 兼容） */
  isApproved(sessionId: string, approvalKey: string): Promise<boolean>;
  /** 先更新 cache（同 run 内立即可见），store wired 则 write-through 持久化 */
  recordAlways(sessionId: string, approvalKey: string): Promise<void>;
}

/** 进程级单例。engine 构造缺省注入；tool-reply-handler 直接 import（同一实例）；bootstrap post-SessionStore 调 setStore。 */
export const approvalManager: ApprovalManager;
```

- **生命周期（per-session 持久化，纠正 v0.0.122 D2 内存不落盘决策）**：持久化字段 `session.alwaysApprovedKeys: string[]`（落 SessionStore CrudStore，见 `../session/[P0]session_store.md §2`），**跨 app 重启保留**该会话内的授权——「永远同意」名实相符。进程级单例 ApprovalManager 持 cache（Map）+ 可选 store（ApprovalStorePort）；bootstrap 在 SessionStore 就绪后调 `approvalManager.setStore(sessionStore)` 注入端口（对齐 `contextEngine.setSessionStore` 模式）。
- **cache-through 语义**：`isApproved` cache hit 不读盘（热路径）；cache miss + store wired → 读 `session.alwaysApprovedKeys` 填 cache 后判定；`recordAlways` 同步更新 cache（同 run 内立即可见）+ write-through 写 store（`SessionStore.addAlwaysApprovedKey` 走 read-modify-write 去重 merge）。
- **isApproved/recordAlways 改 async（v0.0.148）**：因 cache miss 读 store 需 await。调用点（engine.execute `await isApproved` + tool-reply-handler `await recordAlways`）同步改 await。
- **按 sessionId 隔离**：会话 A recordAlways 不影响会话 B（不同 session record、cache 独立 Set）。换会话重置（PRD 路径3：新会话仍弹）。
- **按 approvalKey 记忆**：会话内命中同一 key 的 ask → `isApproved` 返 true → 引擎短路为 allow，不悬挂。

## 6. 回填三分发实例化（tool-reply-handler.ts approval 分支）

兑现 `dispatchByHandleType` 的 approval 分支（现 L174-189 存根，返 status:'pending'）。回填 payload = `{ decision: 'allow' | 'allow_always' | 'deny' }`（前端审批卡提交，对齐 `MessageSender.approval.decision`）。

| decision | 处理 | 产出 block |
|---|---|---|
| `allow` | 补跑原 `tool.run(originalArgs, ctx)`（经执行层沙箱）| `content=result.content`, `status=result.isError?'fail':'success'`, `isError=result.isError` |
| `allow_always` | 同 allow + `await approvalManager.recordAlways(sessionId, approvalKey)`（write-through cache + session.alwaysApprovedKeys 持久化） | 同 allow |
| `deny` | 不执行 | `content=[{text:'用户拒绝执行：{reason}'}]`, `status='fail'`, `isError=true` |

**补跑机制（allow / allow_always）**：
- 原 `arguments` 从 `head.data`（ApprovalData.arguments）取；`reason` / `approvalKey` 从 ApprovalData 取。
- `tool` 从 `spec.config.tools` 按 `head.toolName` 查（复用 callback 分支现有 downcast `spec.config.tools as unknown as Tool[]`，tool-reply-handler.ts L194）。
- ctx 构造复用 callback 分支现有 pattern（config + workdir，L206-209）。
- **约束**：补跑走 `tool.run`（bash → SecureBashEngine），**不再次调 checkPermission**（已经用户批准，避免二次拦截死循环）。
- **[v0.0.124] emit 一致性**：三个 decision 分支（allow/allow_always/deny）编辑出的 `newBlock` 与其它 handleType 一样，由 `handleToolReply` 在持久化后统一经 `emitToolResult` 补发 tool_result 三帧 SSE（本文不分 branch 处理，见 `../agent_interface_and_loop/[P0]agent_hitl.md §2 步骤 4.5 + INV-8`）。审批卡因此在批准/拒绝后实时翻转（success/fail/isError），无须刷新。

**dispatchByHandleType 签名扩展（现状）**：`head` 类型放宽为含 `handleType/toolName/toolCallId/data(ApprovalData)/sessionId` 的 `PendingToolCall` 子集（这些字段 `peekPendingToolCall` 返的 head 本就携带，无需新增 store 读取）。`approvalManager` 由 `tool-reply-handler.ts` **直接 import** `approval-manager.ts` 的进程级单例——与引擎构造缺省的单例**同一个实例**，故 engine ask 门的 `isApproved` 与回填的 `recordAlways` 命中同一 cache（write-through 持久化到 session.alwaysApprovedKeys，跨重启一致）。补跑 tool 从 `spec.config.tools`（downcast `as unknown as Tool[]`）按 `head.toolName` 查；ctx 用 `{config: spec.config, workdir}`（无 loop abort，signal 省略）。

## 7. 与 tool_policy / interaction 的正交关系

| 门 | 管什么 | 位置 | 输出 |
|---|---|---|---|
| `allowedTools`（tool_policy.md） | 这个工具在本 session 能不能用（角色 bound ∩ main） | execute L109（最先） | not-allowed isError（不悬挂） |
| `checkPermission`（本文） | **这次调用的参数**安不安全 | execute 白名单门后、interaction 前 | allow / deny(isError) / ask(悬挂审批卡) |
| `interaction`（tool_execution_engine §5） | 这个工具是不是悬挂型（需外部输入才产 result，如 ask-question） | execute checkPermission 后 | need_feedback 悬挂 / null 正常 run |

三者串行独立：白名单先过 → 策略参数检查 → 悬挂判定 → run。ask 与 need_feedback 共用 pending 基础设施但 subType/handleType 区分（`need_approval`+`approval` vs `need_feedback`+`direct_result`）。

## 8. 核心不变量汇总

- **INV-P1**：allowedTools 与 checkPermission 两道正交门，不替代。
- **INV-P2**：checkPermission 可选钩子，缺省 allow（现状行为不变）。
- **INV-P3**：工具只产 PermissionDecision，审批流程由引擎驱动（工具不感知悬挂/回填）。
- **INV-P4（deny 不悬挂）**：deny → isError 结果直接进 transcript，LLM 可见继续；不进 pending 队列。
- **INV-P5（ask 复用 HITL）**：ask 未同意 → 走 `buildPendingResult` 现有链路（占位/pending/ingest/suspended 全复用 v0.0.101，不新造分支）。
- **INV-P6（approval 持久化 per-session，纠正 v0.0.122 D2）**：ApprovalManager cache-through + ApprovalStorePort，按 (sessionId, approvalKey) 记忆到 `session.alwaysApprovedKeys`（持久化字段）；**跨 app 重启保留**，换会话重置（per-session 范围）。
- **INV-P7（补跑不二次拦截）**：allow 回填补跑 `tool.run` 时不再调 checkPermission（已批准）。
- **INV-P8（绿灯只动审批层，v0.0.148）**：`approvalMode='greenlight'` 只在 ask 分支内短路（视同 allow fall through）；策略层 deny（checkPermission `behavior==='deny'`）在其之前不被绕过；执行层 SecureBashEngine 沙箱不动。绿灯与 always 正交，两者任一满足都 fall through。

## 9. 边界

| 零件 | 归属 |
|---|---|
| PermissionDecision / checkPermission 钩子 / 引擎集成 / ApprovalManager | 本文 ✅ |
| bash 的两条具体策略（ssh-read / rm-wildcard）+ 执行层沙箱 | `[P0]bash_tools.md §4` |
| pending 队列 / suspended / tool_reply / 同 id upsert 编辑机制 | `../agent_interface_and_loop/[P0]agent_hitl.md` |
| 审批卡组件（渲染/testid/可见性） | `../../../ui/components/chat-page/component-pending-approval-card.md` |
| POST /messages toolReply payload={decision} 契约 | `../../../api/overall/04-agent-session.md §3.2` |

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/v0.0.122/change_log.md`。
