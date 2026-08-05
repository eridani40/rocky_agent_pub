---
type: spec
title: Auto Naming Service（触发 hook + CAS 应用 + 起名提示词 + langfuse 观测）
priority: P0
status: active
updated: 2026-07-15
since: v0.0.47
---

# Auto Naming Service

> 实现：`app/server/src/agent/auto-naming-service.ts`（单文件 ≤300 行）。
> 触发点：`app/server/src/handlers/session-messages.ts:107-187` `handleMessagesPost` 内。
> 关联：`index.md`（本 KB 总起 + 核心原则）+ `../session/[P0]session_store.md §2`（titled 字段）+ `../session/[P0]session_event.md §3a`（broadcast）+ `../llm_caller/[P0]llm_caller_overview.md`（invoke + backgroundPath）+ `specs/api/overall/04-agent-session.md §3.2`（POST /messages）。

## 1. 模块边界

**只做**：
- 检测首 query（transcript 无 prior role=user）+ playground scope gate。
- 走 `LlmCaller.invoke`（`backgroundPath:true`）拿 AI 名——复用 adaptive retry / provider 降级 / 错误归一化 / langfuse 闭环。
- CAS 应用（`titled===false` → 写 `{title, titled:true}` + 触发 broadcast）。
- 独立 langfuse trace + 1 个 generation 观测（fire-and-forget 后台任务，无父 trace）。

**不做**：
- 不引 HTTP endpoint（纯内部 service，挂在 POST /messages handler 上）。
- 不裸调 `config.client.call`（绕过 retry/langfuse/错误归一化，v0.0.47–v0.0.83 旧路径，已废弃）。
- 不 hardcode `params`（maxTokens/temperature 全复用 session/model 配置 + invoke `buildRequest` overlay）。
- 不做进度提示 / Toast / 「正在起名」UI（PRD OUT：无起名可观测 UI）。
- 不与主 agent run 的 langfuse trace 关联（auto-naming 起独立 trace）。
- 不写 Session schema（titled 字段定义在 session KB；本模块只**消费** titled 做 CAS gate）。
- 不感知 unread / state / usage / workspace 等其他 session 字段（关注点分离）。

## 2. 触发 hook（首 query + playground gate）

### 2.1 触发点接线

`handleMessagesPost`（`session-messages.ts:107-187`）现有流程：

```
1. getSession → 404 / type=subagent 403 校验
2. body 解析 + plainText 提取（line 133）
3. provider/model 校验 + 落 session 持久（line 136-155）
4. 构造 userMsg（line 160-167）
5. skipActivate 测试守卫（line 172-175）
6. deliverTo（line 179）→ return 202
```

**v0.0.47 新增 step 4.5**（userMsg 构造后、deliverTo 前）：

```typescript
// 4.5 [v0.0.47] AI 起名 hook（不 await，并行触发；首 query + playground scope + 非 subagent）
if (deps.autoNamingService) {
  // fire-and-forget：不 await，不影响 202 返回时序；失败静默
  void deps.autoNamingService.triggerIfFirstQuery(id, plainText).catch(() => {
    /* 静默：任何失败都不影响主 run */
  });
}
```

**为什么 deliverTo 前而非后**：triggerIfFirstQuery 内部异步（getMessages + LlmCaller.invoke），主 run 在另一条 promise；先后顺序对结果无影响（两条独立链路）。放前面让 hook 在主 run 启动前已 fire，时序更直观；放后面也可（功能等价）。

### 2.2 触发条件（gate）

`triggerIfFirstQuery(sid, plainText)` 内部三段 gate（短路；同步 gate 先于异步 gate，fail fast）：

```typescript
async triggerIfFirstQuery(sid: string, plainText: string): Promise<void> {
  try {
    // gate 1: playground scope（biz + derivation）
    const session = await this.store.getSession(sid);
    if (!session) return;
    const biz = session.biz ?? 'playground';          // lazy 默认（[P0]session_biztype.md §3.3）
    if (biz !== 'playground') return;                  // studio 域不起名
    if (session.derivation === 'subagent') return;     // subagent 不起名（由 parent 驱动）

    // gate 2: titled 已置 true（极端兜底；同步 check 先于异步 getMessages，fail fast）
    //   通常 lazy 默认 false；此 check 防御 session 历史上被改过名又因故 titled=true
    if (session.titled === true) return;

    // gate 3: 首 query（transcript 无 prior role=user 消息）—— 关键 gate
    const page = await this.store.getMessages(sid, { limit: 200 });
    const hasPriorUser = page.items.some((m) => m.role === 'user');
    if (hasPriorUser) return;                          // 已有 user 消息 → 非 first query → no-op

    // 通过 gate → 调 applyAiName（内部串行：先 LlmCaller.invoke → 再 CAS）
    await this.applyAiName(sid, plainText);
  } catch {
    // gate/store 失败：fail-silent（无 LLM 资源可回收，无 generation 可 end）。
  }
}
```

> **gate 3 是关键**：它天然保护**所有现存 session**（v0.0.47 之前创建的）不被误触发起名——它们都有 prior user 消息 → gate 3 fail → no-op。故无需 migration 扫存量置 `titled=true`。

> **limit=200 兜底**：扫前 200 条消息判 role=user。新 session 通常 0 条；老 session 上千条时 200 足够覆盖早期 user 消息（按 createdAt 升序返，前 200 含首条 user）。`getMessages` 返 `MessagePage`（`{ items: Message[] }`），故用 `page.items.some(...)`。

> **字段命名（v0.0.56 schema 迁移）**：`session.biz`（非旧 `bizType`）+ `session.derivation`（非旧 `type`）—— v0.0.56 session schema 把 `type/scope/bizType` 三字段收敛为 `biz/role/derivation` 三元组（权威源），见 `session-store.ts:92-100`。auto_naming 只消费 `biz` + `derivation`。

## 3. CAS 应用（titled gate + LlmCaller.invoke）

```typescript
async applyAiName(sid: string, plainText: string): Promise<void> {
  let invokeResp: InvokeResponse | null = null;
  let obs: AutoNamingObs | null = null;          // 独立 trace + generation（fire-and-forget 后台任务）
  let invokeStarted = false;
  try {
    const config = await this.agentManager.resolveConfigBySid(sid);
    // observability 真源 = this.observability（deps 注入的 observabilityManager）—— 见 §6
    obs = this.startGeneration(this.observability, sid, config.modelId, plainText);
    // baseReq 不传 params（D3）：maxTokens/temperature 全复用 session/model 配置 +
    // invoke buildRequest overlay（缺省时 fallback 到 model.capabilities.maxOutputTokens）
    const baseReq: CanonicalRequest = {
      modelId: config.modelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: new AutoNamingHandler().build({ vars: { query: plainText } }).content }] }],
      params: {},
    };
    // ctx 最小集：client/errorState/controller/observability + backgroundPath=true；
    //   onEvent/llmRequestConfig/allProviders/health 不传（起名单 provider 单 attempt 兜底）。
    const ctx: InvokeContext = buildInvokeContext({
      client: config.client,
      errorState: createLlmErrorState(),
      sessionId: sid,
      controller: { runId: 'auto-naming', aborted: false },
      observability: obs?.port,
      backgroundPath: true,
    });
    invokeStarted = true;
    invokeResp = await this.llmCaller.invoke(baseReq, ctx);
    // 成功：invoke 内部已 endGenerationOk；此处不再 end（避免双 end）
  } catch (err) {
    // 失败观测（fail-silent）：invokeStarted=false（resolveConfig/startGeneration/buildInvokeContext
    //   抛）时补 endGenerationError；invokeStarted=true 时 invoke 已 end
    if (obs && !invokeStarted) this.observeFailure(obs, err);
    this.endTrace(obs);
    return;  // LLM 调用失败 / 超时 / parse 失败 → 静默
  }
  this.endTrace(obs);

  const aiName = invokeResp ? extractPlainName(invokeResp) : null;
  if (!aiName || aiName.length === 0) return;       // 空名 → 静默
  const truncated = aiName.length > 60 ? aiName.slice(0, 60) : aiName;

  // CAS gate：re-read session，仅当 titled===false 才应用
  const latest = await this.store.getSession(sid);
  if (!latest) return;
  if (latest.titled === true) return;               // 用户已改名 / 已应用过 AI 名 → 丢弃

  try {
    await this.store.updateSession(sid, { title: truncated, titled: true });
    // 触发 session_meta_update 广播（runtime 自治直调 broadcaster，同 markUnreadTrue 模式）。
    // SessionMetaBroadcaster.broadcast 同步 void 内部已 try/catch 吞异常。
    if (this.metaBroadcaster) this.metaBroadcaster.broadcast(sid);
  } catch {
    // 落库失败：generation 已 endGenerationOk，不重复 end；fail-silent（外层 .catch 兜底）。
  }
}
```

> **走 `LlmCaller.invoke` 不裸调 `config.client.call`（v0.0.84）**：v0.0.47–v0.0.83 起名裸调 `config.client.call`，无 retry / 无 langfuse / 无错误归一化 → thinking 模型 maxTokens 截断 + 网络/限流抖动**系统性静默失败**（AI 名永远停在「新会话」）。v0.0.84 改走 `LlmCaller.invoke` 复用 adaptive retry 全套（`RETRY_BACKOFF`/`FIX_AND_RETRY_MAX_TOKENS`←治 thinking 截断/`ROTATE_KEY`/`FALLBACK`）；`backgroundPath:true` 仅排除 capacity(rate_limit/overload)类重试防雪崩（`llm_caller.ts:354-356`）。

> **baseReq 不传 params（D3）**：旧 `params:{maxTokens:1024, temperature:0}` hardcode 全删（v0.0.64 的 1024 兜底随之退役）。`baseReq.params:{}` 完全复用 session/model 配置 + invoke `buildRequest` overlay（缺省时 fallback 到 `model.capabilities.maxOutputTokens`）。thinking 模型 budget 由 model capabilities 自然兜底——「某 provider 永远不起名」的系统性回归自愈。

> **CAS 非数据库级 WHERE**：`updateSession` 是通用 CRUD（不带 WHERE titled=false）；本 service 在 JS 层 re-read + 判定 + 写。极端竞态（re-read 后、updateSession 前用户改名）概率极低且无害（用户改名会再触发一次 broadcast 覆盖），不做 DB 级 CAS。

### 3.1 extractPlainName（响应解析）

```typescript
function extractPlainName(resp: CanonicalResponse): string | null {
  // resp.message.content[] 取首个 TextBlock.text（注意：CanonicalResponse 是 .message.content，非 .content）
  const block = resp.message.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') return null;
  let name = block.text.trim();
  // 去包围引号（3 趟 regex，覆盖半角 / 全角 smart / 单引号 / CJK 角括号；仅前后成对去，不删内部）
  name = name.replace(/^["“」『]+|["”」』]+$/g, '').trim();   // 半角 " + 全角 “” + CJK 」』
  name = name.replace(/^[「『]+|[」』]+$/g, '').trim();          // CJK「」+ 『』
  name = name.replace(/^['’]+|['’]+$/g, '').trim();             // 半角 ' + 全角 ’
  // 去末尾声明标点（。.!！?？）
  name = name.replace(/[。.!！?？]+$/g, '').trim();
  // 取首行（防止 LLM 返回多行解释）
  name = name.split(/\r?\n/)[0]!.trim();
  return name.length > 0 ? name : null;
}
```

## 4. 起名提示词（`AutoNamingHandler` + `content/auto_naming.md`）

**[v0.0.153] 正文文件化**：起名提示词不再是本模块内的 TS 字面量常量（旧 `NAMING_PROMPT`），改为 `app/server/src/prompts/content/auto_naming.md`（4 条要求 bullet + 末尾 `用户问题：{{query}}` 占位符），经 `AutoNamingHandler`（`app/server/src/prompts/handlers/auto-naming-handler.ts`）读取 + 模板替换。措辞与旧常量逐字一致（迁移时用「原常量快照 + 新实现比对」UT 锁死）；`{{query}}` 替换为用户首条 query 原文，等价于原实现 `NAMING_PROMPT + plainText` 的无分隔符拼接。正文方向 + 通用机制见 `../context/[P0]prompt_content_files.md §4.2`（表格行）+ §5（content 文件清单）。

> **设计意图**：显式「直接给文本无前缀」强约束短输出；解析时再 trim 引号/前缀/标点兜底。`extractPlainName` 是 LLM 输出的**净化层**（容忍 prompt 没完全管住的情况）。
>
> **baseReq params 不 hardcode（v0.0.84 D3）**：maxTokens/temperature 全复用 session/model 配置（详见 §3 注）。起名提示词正文不与具体 token budget 耦合。

## 5. 错误处理（静默失败矩阵 + langfuse 观测）

| 失败场景 | 处理 | langfuse 观测 |
|---|---|---|
| `store.getSession(sid)` null（session 并发删除） | `triggerIfFirstQuery` 早 return（gate 1 fail） | 无 trace 启动（无 generation 可 end） |
| `agentManager.resolveConfigBySid(sid)` throw（config 缺失 / provider 未配） | `applyAiName` catch → `obs && !invokeStarted` 时 `endGenerationError(INTERNAL)` + `endTrace` → 静默 return | trace 启动 + generation `INTERNAL` 错误归一 |
| `LlmCaller.invoke` 抛错（网络/4xx/5xx/timeout/重试耗尽） | `applyAiName` catch → invoke 内部已 `endGenerationError`（按 category 归一化），外层仅 `endTrace` → 静默 return | invoke 内部按 `LlmErrorCategory` 归一记录（CAPACITY/NETWORK/PROVIDER/AUTH 等） |
| `resp.content` 无 TextBlock / text 空 | `extractPlainName` 返 null → 静默 return | invoke 已 `endGenerationOk`（成功调用，只是输出无效）—— trace 留存可追查 |
| AI 名解析后空 / 超长（截断后仍空） | 静默 return | 同上 |
| `store.updateSession` throw（DB 错误） | `applyAiName` 落库 try/catch 静默（已 fire-and-forget，不影响 202 返回） | generation 已 `endGenerationOk`，不重复 end |
| `metaBroadcaster.broadcast` 异常 | 不会抛出——`broadcast` 同步 void 内部已 try/catch 吞异常（spec session_event.md §3a.4）；即便发生也不影响 title 已写入 DB | 同上 |
| `startGeneration` 抛错（observability adapter 故障 / langfuse 不可达） | `startGeneration` 内部 try/catch → 返 null（视为无 observability，invoke 仍跑，零阻塞） | observability 失败本身 fail-silent，绝不向主路径抛 |

> **不变量**：任何 auto-naming 失败都**不抛到 `handleMessagesPost` 主路径**（外层 `.catch(() => {})` 兜底；主 run 已在另一条 promise 独立完成）。AI 起名是「锦上添花」，**绝不阻塞**或**干扰**主 agent run。

> **观测本身 fail-silent（v0.0.84 不变量）**：所有 observability 调用（`startTrace`/`startGeneration`/`endGenerationOk`/`endGenerationError`/`endTrace`）均被 try/catch 包裹吞异常——langfuse 不可达 / SDK 抛错 / port 构造失败 → 视为无 observability，invoke 仍跑、起名仍工作；**绝不**因观测故障让起名失败或影响主路径。

> **防回归守卫（v0.0.64 立，v0.0.84 升级）**：新增 thinking 类 provider（产出 thinking/reasoning block 的模型，如 deepseek-v4-pro、o1、qwq 等）时，**必须**验证起名场景。v0.0.84 起验证口径升级：① 起名功能：首 query → 等 5-10s → 查 session JSON `title` 非默认值 + `titled:true`；② langfuse 观测：查 `name:'auto_naming'` trace 真现（AT 用 `langfuse_wait_for_trace` bounded poll，起名 SDK batch flush 周期较长，poll window ≥40s）。回归信号：title 永远停「新会话」+ `titled:false`（v0.0.84 前）；或功能 pass 但 langfuse 无 trace（observability 接线源错——见 §6 不变量）。

## 6. langfuse 观测接线（v0.0.84 不变量）

### 6.1 observability 真源 = deps 注入（**MUST**，防后续 agent 误用）

`AutoNamingService` 的 observability adapter **必须从 `AutoNamingServiceDeps.observability` 注入**（bootstrap 传 `observabilityManager`，与 `AgentManager` 同源），**绝不能用 `config.observability`**。

**根因**（v0.0.84 AT round1 实证 + 修复坐实）：
- `resolveConfigBySid(sid)` 返回的 `SessionConfig` 来自 `buildSessionConfigFromDeps`（`handlers/session-config.ts` return 块），**该 return 不含 `observability` 字段** → `config.observability === undefined`。
- observability 注入只在 `AgentManager.activate` 方法（`agent-manager.ts:227` 的 `configWithObs`，主 run 路径）里做；起名 `applyAiName` **不走 activate** → 拿到的 `config.observability` 永远 undefined。
- 误用 `config.observability ?? noopAdapter` → 落 `noopAdapter` → **langfuse 永远接不上**（v0.0.84 AT 实证：起名功能 pass 但 langfuse 无 trace）。
- 修复（D5）：`AutoNamingServiceDeps` 加 `observability?: ObservabilityAdapter`，bootstrap 传 `observabilityManager`（line 815-821），`this.observability = deps.observability ?? noopAdapter`。

**代码符号**：`auto-naming-service.ts:AutoNamingServiceDeps.observability`（注释里有完整说明）+ `bootstrap.ts:815-821`（装配点）+ `agent-manager.ts:227 activate.configWithObs`（对照：主 run 注入点）。

> **不变量**：起名 observability 真源 = `this.observability`（deps 注入），**永远不读** `config.observability`。新增任何起名相关 observability 接线时，**第一步**确认用 `this.observability` 而非 `config.observability`。误用必致 langfuse 静默断流（功能仍 pass，无报错，只能 AT langfuse oracle 抓到）。

### 6.2 langfuse trace 命名约定

起名是 **fire-and-forget 后台任务**（无父 trace，不挂主 run 的 trace 链）。每次 `applyAiName` 启**独立 trace + 1 个 GENERATION 观测**：

```typescript
// auto-naming-service.ts:startGeneration
const trace = adapter.startTrace({
  id: `auto-naming-${sid}-${Date.now()}`,       // trace id：auto-naming-{sid}-{timestamp}
  sessionId: sid,
  name: 'auto_naming',                           // trace name（langfuse 检索关键字）
  input: [{ id: 'auto-naming-input', sessionId: sid, role: 'user', content: [...] }],
  metadata: { runId: `auto-naming-${sid}`, sessionId: sid, inputMessageIds: [], modelId, toolNames: [] },
});
const gen = adapter.startGeneration({
  parent: trace,
  model: modelId,
  input: { messages: [], modelId, iteration: 0 },
  startTime: new Date(),
});
const port = createLangfuseObservabilityPort({ adapter, genHandle: gen, iteration: 0, step: 0, model: modelId });
```

**AT langfuse oracle 检索约定**（designer 设计 AT case 按此查）：
- `name === 'auto_naming'`（langfuse trace 顶层 name 字段）
- `metadata.sessionId === sid`
- 含 1 个 type=GENERATION 的 event（起名 LLM call），`model === config.modelId`
- 起名 SDK batch flush 周期较长，AT poll window **必须 ≥40s**（`langfuse_wait_for_trace` bounded poll，禁固定 sleep；详见 memory `langfuse-trace-output-lands-async-last`）

### 6.3 失败观测（endGenerationError 归一）

- **invoke 内部已 endGenerationError**（按 `LlmErrorCategory` 归一：CAPACITY/NETWORK/PROVIDER/AUTH 等）：`applyAiName` catch 仅 `endTrace`，不重复 end。
- **invoke 未启动**（`resolveConfigBySid`/`startGeneration`/`buildInvokeContext` 抛）：`obs && !invokeStarted` 时 `applyAiName` 补 `port.endGenerationError(INTERNAL, reason, { retryChain: [] })` + `endTrace`。
- **成功**：invoke 内部 `endGenerationOk`，`applyAiName` 不 end（避免双 end）。
- **endTrace 幂等**：`obs null 时 noop`；`endTrace` 本身 try/catch 吞异常。

## 7. 与 POST /session body.title 路径 + PUT /session/:id title 路径的协作

POST /session body.title 路径（`session.ts` line 132-150，v0.0.62 修 BUG-001）+ PUT /session/:id body.title 路径（`session-update.ts` applyTitleUpdate helper line 37-44 + `session.ts` line 184-195）都是「用户主动给 session 命名」的入口，都同步置 titled=true：

- **v0.0.47 新增（PUT 路径）**：`updateSession(id, { title: bodyTitle, titled: true })`——手动改名同步置 titled=true（防 AI 名返回时覆盖）。
- **v0.0.47 新增（PUT 路径）**：updateSession 完成后调 `metaBroadcaster.broadcast(sid)`——让前端列表实时刷新 title（之前缺广播，前端列表不刷新）。
- **v0.0.62 新增（POST 路径，修 BUG-001）**：POST /session with body.title 时紧跟 `createSession` 之后调 `updateSession(id, { titled: true })`——对齐 PUT 行为。原因：`createSession` 内部强制 `titled=false`（session-store.ts 设计 invariant：新建一律未命名），故走 CAS gate 翻 true；POST 时若用户已命名而 titled 缺省 false，AI 后续 auto-naming 会 CAS 误判「未命名」覆盖用户字面。**响应形状不变**（仍 201 + Session），仅响应 body 的 `titled` 字段从 lazy `false` 变 `true`（零 API breakage）。

**竞态矩阵**（AI 名 vs 人工改名）：

| 时序 | 用户改名 timing | AI 名返回时 titled | 结果 |
|---|---|---|---|
| 1 | AI 名未返回期间用户改名（POST 创建带 title / PUT 改名） | true（POST/PUT 已置） | AI 名 CAS fail → 丢弃；用户名保留 |
| 2 | AI 名已应用后用户改名（PUT） | true（AI 应用时置） | PUT 直接覆盖；用户名生效 |
| 3 | 用户从未改名（POST 创建无 title） | false → true（AI 应用） | AI 名生效 |
| 4 | 用户改名后撤回（再改回「新会话」） | true（撤回也是 PUT） | AI 名永不再覆盖（PRD 不要求区分 user/ai 来源） |

> **case 4 是 known limitation**：用户主动把名字改回「新会话」字面值，AI 不会再起名（titled=true）。PRD 未要求支持「重置为默认名 → 重新触发 AI 起名」（scope OUT）。

## 8. 触发点接线清单（实现层）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/agent/auto-naming-service.ts` | 新增 | `AutoNamingService` 类（triggerIfFirstQuery + applyAiName + startGeneration + observeFailure + endTrace + extractPlainName + NAMING_PROMPT）；deps: `{ store, agentManager, metaBroadcaster?, llmCaller, observability? }`（v0.0.84 加 `llmCaller` + `observability`） |
| `app/server/src/handlers/session.ts` | 修改 | `SessionHandlerDeps` 加 `autoNamingService?: AutoNamingService`（optional，旧测试不注入则 no-op） |
| `app/server/src/handlers/session-messages.ts` | 修改 | `handleMessagesPost` line 167 后、deliverTo 前加 fire-and-forget hook（§2.1 代码片段） |
| `app/server/src/bootstrap.ts` | 修改 | 实例化 `AutoNamingService({ store, agentManager, metaBroadcaster, llmCaller: { invoke: llmCallerInvoke }, observability: observabilityManager })`（v0.0.84 加 `llmCaller` + `observability`，详见 §6.1）+ 注入 SessionHandlerDeps |

## 9. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ `specs/tech/version_logs/v0.0.47-ui_opt/change_log.md`（跨版本发布说明，coder 编码后补）。
