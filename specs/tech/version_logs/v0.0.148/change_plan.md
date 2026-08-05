# v0.0.148 变更计划书 — session 级 effort 推理强度 + 审批模式（绿灯 / always 持久化）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 符号核对状态：✅ 已 grep/读代码确认所有「修改」类型行引用的符号真实存在（含 enum 闭合性、store facade API、文件路径）。spec↔code 漂移详见末尾「核对说明」。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 内） |
| 函数/符号 | 函数名/类名/interface 名（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁"更新调用链"） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 位置 / 项目原则编号 |
| 预计影响行 | +N / -M |

## 核心设计决策（落 change_plan 的依据）

1. **effort = canonical 统一键**：`RequestParams.effort: 'default'|'low'|'high'|'max'`（语义值，非 wire 字面值）。encode 层做映射注入（low→low / high→high / max→max），**default 档不加 `output_config` 字段**（= 模型厂商默认行为，不是传 `"default"`）。openai 映射（minimal/high/xhigh）写 spec 不实现。
2. **effort 透传链**：`session.effort` → `buildSessionConfigFromDeps` 读 → `config.effort` → `callLLMForSpec` 透传 → `CallLLMInput.effort` → `callLLMViaInvoker` baseReq.params.effort → `encodeAnthropicMessages` 注入 wire。逐环确认符号存在。
3. **ApprovalManager 持久化（纠正 v0.0.122 D2）**：保留 ApprovalManager 类（clean abstraction + 现有测试面），backing 从纯内存 Map 改为 **cache-through + ApprovalStorePort**（setX 注入模式，对齐原则 #6 `contextEngine.setSessionStore`）。isApproved/recordAlways 改 async（cache miss 读 store，write-through 写 store + 更新 cache）。
4. **绿灯（approvalMode）走 SessionConfig**：session 级开关，每 run 读一次 → 放 `config.approvalMode`，engine 直读（无需 store I/O，与 always 的 approvalKey 粒度 + store I/O 正交）。
5. **安全 invariants 不动**：绿灯只动审批层；策略层 deny（engine.ts:187）+ 执行层 SecureBashEngine 沙箱保留。绿灯在 `decision.behavior==='ask'` 分支内短路（deny 分支在其之前，天然不被绕过）。

---

## 变更清单

### 链路 A：effort 透传（session → wire body）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| llm_protocol | app/server/src/llm/protocol.ts | RequestParams | 修改 | 加 `effort?: 'default'\|'low'\|'high'\|'max'` 字段（canonical 语义键，非 wire 字面值）。注释说明 default=不传 wire | MUST 用统一语义值；MUST NOT 在 RequestParams 放 wire 字面值（映射归 encode） | specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.5；原则 #2（protocol 是纯翻译） | +6 |
| llm_protocol | app/server/src/llm/protocol-encode.ts | encodeAnthropicMessages | 修改 | 读 `params.effort`；非 default 档注入 `body['output_config'] = { effort: <mapped> }`（low→low/high→high/max→max）；default/undefined 不加 output_config 字段 | MUST default 档不出现 output_config（等价未挂 effort）；MUST 映射在 encode 内部硬编码（对齐既有字段名映射风格） | PRD v0.0.148 §1.1/§1.2；protocol §3.5 | +12 |
| llm_protocol | app/server/src/llm/protocol-encode.ts | EFFORT_WIRE_MAP（或内联映射） | 新增 | canonical effort → anthropic wire 值映射常量（如 coder 选内联 switch 也可，符号名 coder 定位） | — | PRD §1.1 映射表 | +3 |
| agent-loop | app/server/src/agent/agent-loop-base.ts | CallLLMInput | 修改 | 加 `effort?: 'default'\|'low'\|'high'\|'max'` 字段；注释指明来源 `config.effort`（main+forked 共享） | MUST 缺省 undefined（向后兼容 forked 不传 effort 场景） | agent_loop_base §2.1 | +5 |
| agent-loop | app/server/src/agent/agent-loop-call-via-invoker.ts | callLLMViaInvoker（baseReq 构造 L51-61） | 修改 | baseReq.params 加 `...(input.effort !== undefined ? { effort: input.effort } : {})` 透传 | MUST NOT 在 baseReq 内做映射（映射归 encode） | protocol §3.1 | +2 |
| agent-loop | app/server/src/agent/loop-stage-llm.ts | callLLMForSpec（baseCallLLM 调用 L79） | 修改 | baseCallLLM 入参加 `effort: config.effort`（main+forked 唯一活跃路径，run-react-loop.ts:149 调用） | MUST 透传 config.effort（undefined 也透传，encode 兜底 default） | agent_loop_base §2.1；v0.0.49 design §2 ② | +1 |
| agent-loop | app/server/src/agent/agent-loop-stage-llm.ts | stageLLMRequest（baseCallLLM 调用 L115） | 修改 | baseCallLLM 入参加 `effort: config.effort`（旧入口保留防漂移，见 L179 注释） | MUST 与 callLLMForSpec 同源 config.effort 防 drift | 同上 | +1 |
| session_config | app/server/src/agent/context-types.ts | SessionConfig | 修改 | 加 `effort?: 'default'\|'low'\|'high'\|'max'`（buildSessionConfigFromDeps 从 session.effort 注入） | MUST 缺省 undefined → encode 走 default 档 | context-types SessionConfig；PRD §1.1 | +4 |
| session_config | app/server/src/handlers/session-config.ts | buildSessionConfigFromDeps | 修改 | sessionPersist 参数扩 `effort?`（扩参数对象类型）；返回 config 加 `...(effort !== undefined ? { effort } : {})` | MUST effort 源头唯一 = session record（非 bodyOverride，effort 无 per-request 覆盖语义） | session-config §组装顺序；PRD §1.1 | +5 |
| session_config | app/server/src/handlers/session-config.ts | buildSessionConfigFromDeps（sessionPersist 参数） | 修改 | sessionPersist 对象类型加 `effort?`（与 providerId/modelId 同类持久字段） | — | 同上 | +1 |

### 链路 B：session schema 3 字段（持久化 + 读写链路）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session_store | app/server/src/agent/schema_defs/session.ts | SessionSchema.fields | 修改 | 加 3 字段：`effort`(enum,default/low/high/max,required:false) + `approvalMode`(enum,normal/greenlight,required:false) + `alwaysApprovedKeys`(json,required:false，存 string[]) | MUST 用 enum（effort/approvalMode 闭合性）；MUST alwaysApprovedKeys 用 json（复用 pendingToolCalls 同款 json 透传） | specs/tech/agent/session/[P0]session_store.md §2；PRD §3 | +18 |
| session_store | app/server/src/agent/session-store-types.ts | Session（interface） | 修改 | 加 3 字段：`effort?` + `approvalMode?` + `alwaysApprovedKeys?: string[]`（都 optional，lazy 默认） | MUST optional + lazy 默认（兼容历史 session 无字段 → toSession 缺省） | session_store §2；PRD §3 | +12 |
| session_store | app/server/src/agent/session-store-types.ts | CreateSessionInput | 修改 | 加 `effort?` + `approvalMode?`（alwaysApprovedKeys 不进 create input——新建会话默认 []，由 toSession 缺省） | MUST NOT 把 alwaysApprovedKeys 放 CreateSessionInput（新建无「已批准」语义） | session_store §2 | +4 |
| session_store | app/server/src/agent/session-store-converters.ts | toSession | 修改 | 加 3 字段映射：`effort: r.effort ?? 'default'` + `approvalMode: r.approvalMode ?? 'normal'` + `alwaysApprovedKeys: normalizeKeyArray(r.alwaysApprovedKeys)`（兼容历史 session 缺省 []） | MUST lazy 默认（effort=default / approvalMode=normal / keys=[]）；MUST alwaysApprovedKeys 规范化为 string[] | session_store §2（与 pendingToolCalls/unread/titled 同款 lazy） | +6 |
| session_store | app/server/src/agent/session-store.ts | updateSession | 修改 | patch Pick 扩 `effort`/`approvalMode`/`alwaysApprovedKeys`；read-modify-write：alwaysApprovedKeys 需读 existing + 去重 add（ApprovalManager.addKey 走此路径） | MUST alwaysApprovedKeys 去重（Set 语义）；MUST NOT 覆盖式写（需 merge existing） | session_store §4（updateSession CAS）；PRD §2.1 | +10 |
| api_handler | app/server/src/handlers/session-deps.ts | UpdateSessionBody | 修改 | 加 `effort?` + `approvalMode?`（alwaysApprovedKeys 不进 body——仅 ApprovalManager 内部写，无用户直填语义） | MUST NOT 暴露 alwaysApprovedKeys 到 UpdateSessionBody（防客户端任意改写） | specs/api/overall/04-agent-session.md §2.5；PRD §3 | +4 |
| api_handler | app/server/src/handlers/session.ts | handleSessionItem（PUT 分支 L186-222） | 修改 | updateSession 调用扩 `effort`/`approvalMode` 透传（body 提供则透传，对齐 title/providerId/modelId 模式） | MUST 部分更新语义（未提供字段不覆盖）；MUST 校验 effort/approvalMode enum 值（非法返 400） | api 04-agent-session §2.5 | +6 |
| api_handler | app/server/src/handlers/session.ts | validateProviderModel 或新增 validateEffortApproval | 新增/修改 | enum 值校验：effort ∈ 4 档 / approvalMode ∈ 2 档（非法返 400）。coder 定位：复用既有 validate 风格 or 单独函数 | MUST 非法值返 400（闭合 enum） | api 04 §2.5 | +8 |
| web_api | app/web/src/lib/chat-api.ts | updateSession（body 类型） | 修改 | body 类型扩 `effort?` + `approvalMode?`（对齐 UpdateSessionBody） | MUST 与后端 UpdateSessionBody 同步 | api 04 §2.5 | +2 |

### 链路 C：ApprovalManager 持久化（纠正 v0.0.122 D2）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响 |
|---|---|---|---|---|---|---|---|
| tool_approval | app/server/src/tools/approval-manager.ts | ApprovalStorePort（interface） | 新增 | 端口接口：`getAlwaysApprovedKeys(sid): Promise<string[]>` + `addAlwaysApprovedKey(sid, key): Promise<void>`。SessionStore 实现此 port（或 bootstrap 包 adapter） | MUST 端口薄（2 方法）；MUST NOT 耦合 SessionStore 具体类（依赖倒置） | 原则 #6（setX 注入）；tool_permission §5 | +8 |
| tool_approval | app/server/src/tools/approval-manager.ts | ApprovalManager（class） | 修改 | backing 从纯内存 Map 改 cache-through：加 `private store?: ApprovalStorePort` + `setStore(port)`；isApproved/recordAlways 改 async；isApproved cache miss 读 store 填 cache；recordAlways 更新 cache + write-through store | MUST isApproved/recordAlways 改 async（engine/tool-reply-handler 调用点同步改 await）；MUST 保持 Map 作 cache（避免每次 isApproved 读盘）；MUST cache 与 store 一致（write-through） | tool_permission §5（纠正 D2）；PRD §2.1 | +25/-6 |
| tool_approval | app/server/src/tools/approval-manager.ts | ApprovalManager.isApproved | 修改 | 签名 `→ boolean` 改 `→ Promise<boolean>`；cache hit 返 true；miss 且 store wired → 读 store 填 cache 后返；miss 且无 store → false（向后兼容 UT） | MUST cache miss 才读 store（热路径 cache 优先） | 同上 | +6/-2 |
| tool_approval | app/server/src/tools/approval-manager.ts | ApprovalManager.recordAlways | 修改 | 签名 `→ void` 改 `→ Promise<void>`；先更新 cache（去重 add），store wired 则 write-through addAlwaysApprovedKey | MUST 去重（Set 语义）；MUST cache 先更（同 run 内立即可见） | 同上 | +5/-2 |
| tool_approval | app/server/src/tools/approval-manager.ts | ApprovalManager.setStore | 新增 | 注入 ApprovalStorePort（post-bootstrap 调，对齐 contextEngine.setSessionStore 模式）；缺省 undefined（UT 隔离） | MUST NOT 构造函数注入（bootstrap 顺序：ApprovalManager 单例先于 SessionStore） | 原则 #6 | +3 |
| session_store | app/server/src/agent/session-store.ts | SessionStore（实现 ApprovalStorePort） | 修改 | 实现 getAlwaysApprovedKeys（读 session.alwaysApprovedKeys，兼容缺省 []）+ addAlwaysApprovedKey（读 existing + 去重 add + updateSession 写回） | MUST addAlwaysApprovedKey 用 read-modify-write 去重（复用链路 B 的 updateSession alwaysApprovedKeys patch） | session_store §4；PRD §2.1 | +12 |
| tool_engine | app/server/src/tools/engine.ts | ToolExecutionEngine.execute（L193 isApproved 调用） | 修改 | `this.approvalManager.isApproved(...)` 改 `await this.approvalManager.isApproved(...)`（已在 async execute 内） | MUST await（isApproved 改 async） | engine §3（策略门） | +1/-1 |
| tool_reply | app/server/src/agent/tool-reply-handler.ts | dispatchByHandleType（L255 recordAlways 调用） | 修改 | `approvalManager.recordAlways(...)` 改 `await approvalManager.recordAlways(...)`（dispatchByHandleType 已 async） | MUST await（recordAlways 改 async） | tool_permission §6（allow_always 分支） | +1/-1 |
| bootstrap | app/server/src/bootstrap.ts | bootstrap（toolEngine 构造后 L515 附近） | 修改 | SessionStore 构造后调 `approvalManager.setStore(sessionStore)`（或包 adapter：若不想 SessionStore 直接实现 port，bootstrap 构造 adapter 包装 sessionStore 的两个方法） | MUST SessionStore 就绪后才调 setStore；MUST 单例 approvalManager（从 approval-manager.ts import）与 engine 共用 | 原则 #6；bootstrap §工具装配 | +3 |

### 链路 D：engine 绿灯短路（approvalMode）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响 |
|---|---|---|---|---|---|---|---|
| tool_engine | app/server/src/tools/engine.ts | ToolExecutionEngine.execute（ask 分支 L191-202） | 修改 | ask 分支内、isApproved 判定前加绿灯短路：`if (config.approvalMode === 'greenlight') { /* fall through，跳过审批卡 */ } else if (!await isApproved(...)) { pending; continue; }`。deny 分支（L187）在其之前不动 | MUST 绿灯只在 ask 分支内短路（deny 在 ask 之前，天然不被绕过）；MUST greenlight → fall through（视同 allow，仍走后续 interaction/run）；MUST NOT 改 deny 路径 | tool_permission §4（策略门）+ §5；PRD §2.2 安全边界 | +6/-2 |
| tool_engine | app/server/src/tools/types.ts | ToolSessionConfigLike | 修改 | 加 `approvalMode?: 'normal'\|'greenlight'`（鸭子类型，engine 直读 config.approvalMode） | MUST optional（缺省 undefined → 走 normal 分支，向后兼容） | tool_execution_engine §3；types.ts ToolSessionConfigLike | +4 |
| session_config | app/server/src/agent/context-types.ts | SessionConfig | 修改 | 加 `approvalMode?: 'normal'\|'greenlight'`（与 effort 同款，buildSessionConfigFromDeps 注入） | MUST 缺省 undefined → engine 走 normal | context-types SessionConfig | +4 |
| session_config | app/server/src/handlers/session-config.ts | buildSessionConfigFromDeps（sessionPersist + return） | 修改 | sessionPersist 扩 `approvalMode?`；return config 加 `...(approvalMode !== undefined ? { approvalMode } : {})` | MUST 源头唯一 = session record | session-config §组装顺序 | +5 |
| session_config | app/server/src/handlers/session-config.ts | buildSessionConfigFromDeps 调用方（bootstrap/session-messages/session-compact） | 修改 | 各调用方传 sessionPersist 时补读 `session.effort` + `session.approvalMode`（getSession 后透传） | MUST 所有 buildSessionConfigFromDeps 调用点同步补字段（防部分路径 effort/approvalMode 丢失） | session-config §调用方；PRD §1.1（forked 共享 session.effort） | +6 (3 处 × 2) |

### 链路 E：组件 spec（coder 编码前置产出，先 spec 后实现 — 非本文件展开）

> 两个新 picker（component-input-effort-picker / component-input-approval-mode-picker）的 `.md` + `.tsx` spec 由 coder 在编码前置产出（标准见 `specs/ui/components/_conventions.md`）。架构师只定清单：

| 组件 spec | 归属目录 | 几何/交互基线 |
|---|---|---|
| component-input-effort-picker.md | specs/ui/components/chat-page/ | 复用 component-input-model-picker（21px trigger + hover 预览 + click 菜单 + absolute 脱流 + z-popover）；trigger testid `chat-effort-picker` + menu `effort-picker-menu` + item `effort-picker-item-{level}` |
| component-input-approval-mode-picker.md | specs/ui/components/chat-page/ | 同款几何；trigger `chat-approval-mode-picker` + menu `approval-mode-picker-menu` + item `approval-mode-picker-item-{mode}` |

落点：`app/web/src/components/chat-page/section-chat-detail.tsx` input-bar 按钮行（L334），按钮行从 3 控件（picker/send/stop）扩到 5 控件（approval-mode/effort/picker/send/stop）。

---

## 影响面评估

**跨模块**：llm_protocol（encode）+ agent-loop（effort 透传 2 stage 点）+ session_store（schema/类型/converter/update）+ api_handler（PUT + body）+ tool_approval（ApprovalManager 持久化改造）+ tool_engine（绿灯短路 + isApproved async）+ session_config（buildSessionConfigFromDeps 2 字段）+ web_api（updateSession body）+ bootstrap（setStore 装配）+ 前端 2 新 picker。

**破坏性变更**：
- `ApprovalManager.isApproved` / `recordAlways` 签名 sync→async（**public API 变更**，2 调用点同步改 await，破坏 approval-manager.test.ts 断言形态——coder 同步改测试）。
- `Session` interface 加 3 字段（optional，向后兼容）。
- `UpdateSessionBody` 加 2 字段（optional，向后兼容）。

**依赖顺序**（底层先）：protocol.RequestParams/encode → agent-loop CallLLMInput/callLLMForSpec → session schema/types/converter → session-config → ApprovalManager port + engine → bootstrap 装配 → handler → web_api → 前端 picker。

**风险点**：
1. **isApproved async 化**：engine.execute 已 async，await 无碍；但须确认无同步调用点残留（UT mock 同步返值需改 Promise.resolve）。
2. **buildSessionConfigFromDeps 多调用点**：effort/approvalMode 必须所有调用点同步补，否则部分路径（如 compact forked）effort 丢失——coder 须 grep 全部调用点。
3. **alwaysApprovedKeys read-modify-write 竞态**：updateSession 已用 putAsync 串行化（session-store.ts:225），addAlwaysApprovedKey 复用此路径安全。
4. **packaged 护栏**：本版无新 npm 依赖、无新 plugin、无新 runtime env 键、无新 fs 路径——四类 packaged 陷阱均不触发。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计

---

## 核对说明（architect 落 change_plan 行前核对结果）

✅ **已核对真实存在的符号**（grep + 读代码确认）：
- `RequestParams`（protocol.ts:49）、`encodeAnthropicMessages`（protocol-encode.ts:46）、`CallLLMInput`（agent-loop-base.ts:134）、`callLLMViaInvoker` baseReq（agent-loop-call-via-invoker.ts:51-61）
- `callLLMForSpec`（loop-stage-llm.ts:40，run-react-loop.ts:149 调用 — **main+forked 唯一活跃路径**）、`stageLLMRequest`（agent-loop-stage-llm.ts:69，旧入口 L179 注释保留）
- `SessionSchema`（schema_defs/session.ts:20，enum/json 字段风格已核对 pendingToolCalls:185/unread:90/titled:99）
- `Session` interface（session-store-types.ts:64）、`CreateSessionInput`（:303）、`toSession`（session-store-converters.ts:47）、`updateSession`（session-store.ts:195，patch Pick 类型 L198）
- `UpdateSessionBody`（session-deps.ts:157，当前 3 字段 title/providerId/modelId）、`handleSessionItem` PUT 分支（session.ts:186-222）、`updateSession`（chat-api.ts:67）
- `ApprovalManager`（approval-manager.ts:22，Map:27/isApproved:36/recordAlways:47/单例 approvalManager:63）、`ToolExecutionEngine`（engine.ts:100，approvalManager 注入:110，isApproved 调用:193，ask 分支:191-202，deny:187）
- `dispatchByHandleType`（tool-reply-handler.ts:198，recordAlways 调用:255）、`buildSessionConfigFromDeps`（session-config.ts:124，sessionPersist 参数:127，return:280）
- `bootstrap.ts:515` `new ToolExecutionEngine()`（零参，用单例 approvalManager）

⚠️ **spec↔code 漂移（architect 凭 spec 概念可能误引，coder 按代码实际调整 + 汇报）**：
- task 路径：context.md 写 `app/server/src/tools/tool-reply-handler.ts`，**实际路径 = `app/server/src/agent/tool-reply-handler.ts`**（在 agent/ 非 tools/）。coder 按实际路径改。
- `buildSessionConfigFromDeps` 调用点：session-config.ts:127 sessionPersist 当前仅 `{providerId?, modelId?}`，扩 effort/approvalMode 须同步改所有 caller（bootstrap/session-messages/session-compact）传参——coder grep `buildSessionConfigFromDeps(` 找全调用点。

📌 **coder 定位（开放点，coder 有技术决策权，偏离须汇报）**：
- `EFFORT_WIRE_MAP` 是抽 const 还是内联 switch（protocol-encode.ts）— coder 定位
- `ApprovalStorePort` 由 SessionStore 直接 implements 还是由 bootstrap 包 adapter — coder 定位（推荐直接 implements，SessionStore 已有 updateSession/getSession）
- `validateEffortApproval` 是独立函数还是复用 validateProviderModel 风格 — coder 定位
- ApprovalManager cache 失效策略：本版无跨 session 失效需求（per-session 隔离），cache 随进程生命周期；若 coder 判定需 LRU 上限可加，但非必须
