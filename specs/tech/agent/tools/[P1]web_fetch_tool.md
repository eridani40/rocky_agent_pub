---
type: spec
title: Web Fetch Tool（ContentFetcher 契约 + 2 实现 race）
priority: P1
status: active
updated: 2026-07-30
since: v0.0.23
---

# Web Fetch Tool — ContentFetcher 契约 + 2 实现（jina / local 含 headless 子分支）

web_fetch 工具：抓单 URL → 系统代理 → SSRF 校验 → **2 个 `ContentFetcher` 实现 race**（`JinaContentFetcher` ∥ `LocalContentFetcher`，**headless 是 Local 内部子分支**）→ markdown。
体系定位见 `[P1]web_tools.md`；调研依据 `specs/research/v0.0.23-web-fetch.md`。

**核心设计**：抽象 `ContentFetcher` 契约（接口），2 个实现——`JinaContentFetcher`（走 r.jina.ai）与 `LocalContentFetcher`（本地静态 + **内部 headless 子分支**）。race runner 用**共享 AbortController 构造注入**每个执行者；首个合格结果胜出 → abort 其他；被取消方在 abort 路径 detached 清理资源。
**Bun 兼容防回归**：BUG-003（undici `close()` 在 Bun 不存在 → 须 `typeof close==='function'` 守卫）；BUG-005（Bun undici 忽略 dispatcher 超时 → 用 `AbortSignal.timeout`）。
**不强依赖 chromium**：headless 是 `LocalContentFetcher` 内部**优雅降级**子分支——headless 起 chromium 失败（如二进制缺失）→ 返回 `{ ok:false }` → race 中 jina 胜出（jina 服务端渲染 JS）。即使未装 chromium，web_fetch 仍可工作（jina 兜底）。chromium 装机见 `[P1]browser_tool.md` §11。

## 1. 概述与管线

```
url → undici EnvHttpProxyAgent（读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY）
  → SSRF 校验（必须在任何抓取之前：挡内网/file://，防内部 URL 泄漏给 jina）
       命中 → 返回错误（不抓取）
  → ★ race runner：创建共享 AbortController，构造注入 2 个 ContentFetcher：
       JinaContentFetcher（GET r.jina.ai/<url>，jina 服务端渲染 JS，Bearer if key）
       LocalContentFetcher:
         ├─ 静态子分支：proxyFetch(url) + readability（快、不渲染 JS）
         └─ 若静态内容不足（trim ≤ MIN_CONTENT~200）→ 内部起 headless 子分支：
              NodeWorkerDriver 一次性 render（goto waitUntil:domcontentloaded → page.content()）→ readability（贵，仅 JS 页触发）
     两 fetcher 并行 Promise.any，首个「合格」（ok 且 trim 正文 ≥ MIN_CONTENT）者胜。
  → 首个合格结果胜 → controller.abort() 取消另一个 → 主流程立即返回（不等被取消方清理）
  → 两 fetcher 都无合格结果 → null + onFailure 透出各 fetcher 失败归因（调用方写 error.log 后决定 isError）
  → wrapExternalContent（untrusted）→ 截断（~maxChars，走 context offload）→ ToolResultBlock
```

**设计要点**：
- **SSRF 永远最先**：内部地址/file:// 本地挡掉，绝不发往 jina（防 URL 泄漏 + 门禁有效）。公网 URL 才放行。
- **`ContentFetcher` 契约统一**：2 个实现共享接口（`id` + `fetch(ctx)`），race runner 不感知实现差异；新增实现只需实现接口并注册。
- **headless 归 Local**（重构核心）：headless 渲染不是顶层第 3 个竞争者，而是 `LocalContentFetcher` 内部「静态不充足时」的子分支——Local 自己决定何时起 chrome，runner 不知情。
- **AbortController 构造注入**：runner 创建一个共享 `AbortController`，**构造每个 fetcher 时把 `signal` 塞进构造参数**（不是后传）。fetcher 从出生持有 signal，内部所有子操作（jina fetch / 本地静态 fetch / local 的 headless 起 chromium）**一开始就接好 abort**。
- **detached 清理**：胜出方 abort 输方；输方正在飞的子操作抛 AbortError，**finally 块做资源清理**（关 dispatcher / 关 page+context+kill chrome）。清理 best-effort、不抛、detached（`.catch(()=>{})`），但**必须真执行**。
- **jina 非硬依赖**：`web.jinaEnabled=false`（隐私敏感/airgapped）→ 不构造 JinaContentFetcher，只跑 Local。

## 2. web_fetch Tool 层

```typescript
const webFetchTool: Tool = {
  definition: {
    name: 'web_fetch',
    description: 'Fetch a URL, return main content as clean markdown. Races 2 ContentFetchers (jina-reader ∥ local incl. headless sub-branch), first adequate wins. System-proxy aware, SSRF-guarded.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        maxChars: { type: 'number', default: 100000 },
        render: { type: 'boolean', default: false, description: '强制 headless 渲染（已知 JS 页或静态内容不全时；跳过静态直起 headless）' },
      },
    },
  },
  needsApproval(input, ctx) { /* 跨域敏感域名可 HITL，见 §7 */ },
  async run(input, ctx) {
    try { assertSsrfSafe(input.url); }                                 // SSRF 先行（jina 之前）
    catch (e) {
      writeWebFetchErrorLog(ctx.config.logWriter, { tool:'web_fetch', url, stage:'ssrf', reason });
      return isError(`web_fetch: SSRF 拒绝 — ...`);
    }
    const headlessRenderer = buildHeadlessRenderer(driverRegistry);    // §3.3：检测 executeOnce，无则 undefined 优雅降级
    let raceFailures: FetchFailure[] = [];
    const md = await fetchContent(input.url, { maxChars: input.maxChars, signal: ctx.signal,
      headlessRenderer, forceHeadless: input.render === true, onFailure: f => { raceFailures = f; } });      // §1 管线；两路皆空透出归因
    if (!md) {
      writeWebFetchErrorLog(ctx.config.logWriter, { tool:'web_fetch', url, stage:'race',
        reason:'所有抓取路线均无充足内容', failures: raceFailures });
      return { content: [text('web_fetch: 所有抓取路线均无充足内容')], isError: true };
    }
    return { content: [text(truncate(wrapExternalContent(md.content), input.maxChars))], isError: false };
  },
};
```

**失败路径 error.log（`writeWebFetchErrorLog`）**：三类失败各写一条 `LogWriter('error')`——① SSRF 拒绝/异常（`stage:'ssrf'`）；② fetchContent 抛错（`stage:'race'`）；③ 两路皆空（`stage:'race'` + `failures:[{fetcher,reason}]` 各 fetcher 归因）。记录字段 `tool:'web_fetch'`/`url`/`stage`/`reason`/`failures?`。复用 `ctx.config.logWriter`（`unknown` 鸭子类型，能力探测有 `write` 方法才调，对齐 engine.ts `writeToolLog` 模式）；`enableErrorLog` 开关在 LogWriter 内部判定（`?? false` 早 return，见 `dev-logs` KB §3.6）；缺省 undefined → no-op。**日志失败静默**（try/catch 吞掉，绝不冒泡进工具主流程）；不泄 jina key。

`fetchContent` 内部按 §3 编排：构造 2 个 fetcher（signal 构造注入）→ 并行 race → 首合格胜出 abort 另一个 → 主流程返回。**对外契约不变**（input/output 与 v1.2 一致）。

## 3. Layer 3 内容获取（ContentFetcher 契约 + 2 实现 race）

### 3.1 `ContentFetcher` 契约（接口）

```typescript
/** 单次 fetch 的上下文（race runner 构造 fetcher 后调 fetch 时传入）。
 *  signal 不在此——signal 走构造注入（§6.2），fetch 只需 url。 */
interface FetchContext {
  url: string;
}

/** fetch 结果 */
interface FetchResult {
  title: string;
  content: string;        // markdown 正文（调用方再 wrap + truncate）
  source: 'jina' | 'local' | 'headless';  // headless 仍由 Local 内部产生，标 source 区分
  ok: boolean;            // true = 拿到合格内容；false = 失败/不充足
  err?: string;           // 失败原因（ok=false 时填，观测用途：race runner 透出给上层写 error.log 定位哪路为何挂）
}

/** 内容抓取者契约。2 个实现：JinaContentFetcher / LocalContentFetcher。 */
interface ContentFetcher {
  /** 实现标识 */
  id: 'jina' | 'local';
  /** 抓取。signal 由构造注入；实现内所有子操作必须接好此 signal。
   *  胜出由 runner 判定（合格 = ok && trim(content) ≥ MIN_CONTENT）；
   *  本方法只负责「尽最大努力拿内容」，返回 ok=false 不抛（让 runner 跑完 race）。 */
  fetch(ctx: FetchContext): Promise<FetchResult>;
  /** 资源清理（detached，best-effort，不抛）。
   *  runner 在 race 结束（无论胜败）后调用一次；实现内须保证：
   *  即使 fetch 被 abort 中断，finally 关掉所有 dispatcher/浏览器。 */
  cleanup(): Promise<void>;
}
```

**契约要点**：
- `signal` **构造注入**：`new JinaContentFetcher({ signal, devConfig, fetchImpl })`——fetcher 内部存 signal 字段，所有子操作一开始就接好。
- `fetch` **不抛**：失败/不充足返回 `ok:false`（带空 content），让 runner 用 `Promise.any` 跑完 race。
- 合格判定**在 runner**（不在 fetcher）：fetcher 只报「我拿到了什么」，runner 判 trim 长度是否 ≥ MIN_CONTENT。
- `cleanup()` 独立方法：runner 在 race 结束后对**每个** fetcher（胜方+输方）调一次，detached。

### 3.2 `JinaContentFetcher` 实现

```
构造：new JinaContentFetcher({ signal, devConfig, fetchImpl })   // devConfig 字段名保留（v0.0.89 桥接 app_config，见 config/[P0]app_config.md §3.10）
  - 读 app_config web group：jinaApiKey（有则带 Bearer，无则匿名）、jinaTimeoutMs~28s（DEFAULT_JINA_TIMEOUT_MS）
  - signal 字段保存

fetch(ctx):
  headers = { Accept: 'text/markdown' }
  if (devConfig.jinaApiKey) { headers.Authorization = `Bearer ${key}`; console.log(`[jina-fetcher] key=${maskKey(key)}`) }
  else console.log('[jina-fetcher] key=anonymous')   // 无 key → anonymous（观测请求走鉴权还是匿名，不泄真值）
  // 超时用 AbortSignal.timeout 合并进 signal（BUG-005：不用 undici dispatcher 超时）
  const timeoutSig = AbortSignal.timeout(jinaTimeoutMs)
  const merged = mergeSignal([ctx.signal, timeoutSig])
  resp = await proxyFetch(`https://r.jina.ai/${url}`, { headers, signal: merged })
  → 2xx → markdown（jina 服务端已渲染 JS + 提取）
  → 返回 { title:'', content: text, source:'jina', ok: resp.ok && text 非空 }
  finally: （undici dispatcher 在 proxyFetch 内部 close，BUG-003 守卫）

cleanup():
  // proxyFetch per-call dispatcher 已在 fetch finally 关；此处 idempotent no-op
  return Promise.resolve()
```

**关键**：jina 自带 JS 渲染（r.jina.ai 服务端渲染）；超时用 `AbortSignal.timeout`（BUG-005）。默认 28s（`DEFAULT_JINA_TIMEOUT_MS`，≤ race 总超时 `OVERALL_TIMEOUT_MS` 30s 留 2s 余量；原 20s 对大页不够）。

**masked-key 观测日志**：发请求处 `console.log('[jina-fetcher] key=<masked>')`（有 key）/ `'[jina-fetcher] key=anonymous'`（无 key），仅用于观测本次请求走 Bearer 鉴权还是匿名，不泄真值。脱敏走 `mask-key.ts:maskKey(value)` 纯函数，规则与前端 `secret-input.tsx:maskSecret` 完全一致（不跨包引前端）：len≤4 全 `*`；4<len≤8 首 1 + 中 `*` + 末 1；len>8 首 4 + 中 `*` + 末 4；len=0 空串。仅日志观测，不改抓取链路（`console.log` 是纯 side-effect，Authorization header 逻辑不变）。

### 3.3 `LocalContentFetcher` 实现（**含 headless 子分支**）

```
构造：new LocalContentFetcher({ signal, resolveDns, fetchImpl, headlessRenderer, forceHeadless })
  - signal 字段保存；headlessRenderer 可注入（生产=tool.ts buildHeadlessRenderer 包装
    driver.executeOnce（NodeWorkerDriver 一次性 render），UT=mock）；forceHeadless 缺省 false

fetch(ctx):
  try {
    // 子分支 1：静态 fetch + readability（快）—— forceHeadless=true 时整体跳过，直起 headless
    if (!forceHeadless) {
      const { finalUrl, response } = await fetchWithRedirectGuard(url, { signal }, ...)   // signal=构造注入字段
      const html = await response.text()
      const static_result = await extractMainContent(html)
      if (trim(static_result.content).length ≥ MIN_CONTENT)
        return { title: static_result.title||finalUrl, content, source:'local', ok:true }
    }
    // 子分支 2：静态不足/跳过 → 内部起 headless 渲染（贵，仅 JS 页）
    if (headlessRenderer) {
      try {
        const rendered = await headlessRenderer(url, signal)   // signal=构造注入字段；生产=driver.executeOnce('render')：goto domcontentloaded → page.content()
        const h_result = await extractMainContent(rendered)
        if (trim(h_result.content).length ≥ MIN_CONTENT)
          return { title: h_result.title, content, source:'headless', ok:true }
        headlessReason = `headless 内容不足（trim ${h_result.content.trim().length} < ${MIN_CONTENT}）`
      } catch (e) {
        headlessReason = `headless 渲染失败：${e.message}`   // 透出渲染器真实 error（chrome_not_found/worker stderr/等）非笼统，供 error.log 定位
      }
    }
    return { title:'', content:'', source:'local', ok:false, err:`${staticReason}；${headlessReason}` }
  } finally {
    // 静态 fetch 的 dispatcher 在 proxyFetch 内部 close（BUG-003 守卫）
    // headless 的 chrome 清理由一次性 worker 模型负责（§3.5 清理表）
  }

cleanup():
  // 主要清理在 headlessRenderer 内部 finally；此处 idempotent
  return Promise.resolve()
```

**关键**：
- **headless 是 Local 内部子分支**，不是顶层第 3 个竞争者。Local 自己判定「静态不足 → 起 headless」。
- **headlessRenderer 契约**：`(url, signal) => Promise<string>`——返回渲染后 HTML。**生产实现 = `tool.ts buildHeadlessRenderer`**：检测 registry 取的 headless driver 有无 `executeOnce`（NodeWorkerDriver 一次性模型，无 connect 长 session——绕 Bun connectOverCDP hang 的既有设计，见 `[P1]browser_tool.md` §3）；有则 renderer 内部调 `executeOnce({headless:true}, 'render', {url}, signal)` → worker 内 `page.goto(url,{waitUntil:'domcontentloaded'})` → `page.content()` 返回渲染 HTML（domcontentloaded 后 DOM 就绪 JS 渲染内容已在；load 等所有资源对持续加载页面超时）；**无 executeOnce（如 PlaywrightDriver 长 session 模型）→ 返回 undefined，headless 子分支整体跳过（优雅降级）**。chrome 清理由一次性 worker 模型保证（spawn → task → result → killProcessGroup，无长 session 残留，防孤儿 chromium），并接受 signal abort（race 输掉时被 abort）。
- 静态分支用 `fetchWithRedirectGuard`（逐跳 SSRF + DNS pinning + 跨 origin 剥凭证，§4）。
- Local 失败路径返回 `ok:false` 且填 `err` 归因（静态失败/不足 + headless 失败/不足的组合描述），透出给 race runner 写 error.log（§3.4）。**headless 渲染器抛错时捕获真实 message**（`chrome_not_found` / worker stderr / 等，非笼统「headless 渲染失败」），拼进 `err` 供诊断（`local-fetcher.ts` `HeadlessOutcome.err` 字段承载，`fetchHeadless` try/catch 透出）。

### 3.4 race runner（fetchContent 编排）

```typescript
// options: { signal?, resolveDns?, fetchImpl?, appConfig?, headlessRenderer?,
//            forceHeadless?: boolean,   // render=true 时跳过静态直起 headless
//            onFailure?: (failures: FetchFailure[]) => void }   // 两路皆空时透出 [{fetcher, reason}]（观测用途，不抛）
async function fetchContent(url, options): Promise<FetchContentResult | null> {
  await resolveAndCheck(url, resolveDns);                          // 起始 SSRF（jina 之前）
  const signal = options.signal;                                   // 外部 ctx.signal
  const timeoutSig = AbortSignal.timeout(OVERALL_TIMEOUT_MS);      // BUG-005：总超时
  const raceController = new AbortController();                    // ★ 共享 race abort
  // 合并：外部 signal + 总超时 + race abort → 每个构造注入的 raceSignal
  const raceSignal = mergeSignal([signal, timeoutSig, raceController.signal]);

  // ★ 构造注入：创建 fetcher 时就把 signal 塞进构造参数
  const fetchers: ContentFetcher[] = [];
  if (jinaEnabled) fetchers.push(new JinaContentFetcher({ signal: raceSignal, devConfig, fetchImpl }));
  fetchers.push(new LocalContentFetcher({ signal: raceSignal, resolveDns, fetchImpl, headlessRenderer, forceHeadless: options.forceHeadless }));

  // 包成「合格才 resolve，否则 reject」让 Promise.any race
  // （signal 已构造注入，fetch 只传 { url }；reject 携带 fetcher 归因供 onFailure 收集）
  const racing = fetchers.map(f =>
    f.fetch({ url }).then(r => {
      if (!r.ok || r.content.trim().length < MIN_CONTENT) {
        const reason = !r.ok ? (r.err ?? '抓取失败') : `内容不足（trim ${r.content.trim().length} < ${MIN_CONTENT}）`;
        throw Object.assign(new Error(`${f.id}: ${reason}`), { fetcher: f.id });
      }
      raceController.abort();                                      // 胜出 → 取消另一个
      return r;
    })
  );

  let winner: FetchContentResult | null = null;
  try { winner = await Promise.any(racing); }
  catch (e) {
    winner = null;
    // 两路皆空：AggregateError 收集各 fetcher 失败归因 → onFailure 同步透出（观测用途，供 tool 层写 error.log）
    if (e instanceof AggregateError && options.onFailure)
      options.onFailure(e.errors.map(x => ({ fetcher: x.fetcher ?? 'unknown', reason: x.message ?? String(x) })));
  }

  // ★ detached 清理：每个 fetcher 都清（胜方+输方），best-effort 不抛，主流程不等
  for (const f of fetchers) f.cleanup().catch(() => {});

  return winner;   // null → 调用方决定 isError
}
```

**race 语义要点**：
- **构造注入而非后传**：`raceSignal` 在 `new XxxContentFetcher({signal})` 时塞进，fetcher 内部所有子操作（jina fetch / 本地静态 / local 的 headless 起 chrome）一开始就接好。
- **首合格胜出 → abort**：`raceController.abort()` 触发另一 fetcher 持有的 signal abort，其正在飞的子操作抛 AbortError。
- **主流程不等清理**：`Promise.any` 拿到 winner 立即返回；`f.cleanup().catch(()=>{})` detached——cleanup 必须真执行（关 dispatcher / 关浏览器），但主流程不 await 它。
- **AbortSignal.timeout 合并超时**（BUG-005）：不依赖 undici dispatcher 的 `headersTimeout/bodyTimeout`（Bun undici 忽略），用 `AbortSignal.timeout(ms)` 合并进 signal。
- **失败归因透出（onFailure）**：两路皆空（Promise.any 抛 AggregateError）时，各 fetcher 的 reject 携带 `{fetcher, reason}`（reason 取 `FetchResult.err` 或「内容不足」描述），runner 归集成 `FetchFailure[]` 经 `options.onFailure` 同步回调透出（return null 之前）——纯观测用途，供 tool 层写 error.log 定位哪一路为何挂；不改 race 语义/合格判定，回调自身异常吞掉不影响主流程。

### 3.5 abort 传播 + 清理点时序

```
T0  runner 构造 raceSignal（外部 + timeout + raceController）→ 注入 2 fetcher
T1  Promise.any 启动两 fetcher.fetch()，各自子操作接 raceSignal
T2  假设 jina 先返回合格：
      └─ jina then: raceController.abort()
            ├─ local 的 raceSignal abort
            │    ├─ 静态 fetch 抛 AbortError（proxyFetch finally: typeof close==='function' && close()）
            │    └─ 若 headless 已起：executeOnce 收到 abort → driver killProcessGroup(worker 子进程)
            │       （worker 正常路径在 emit 前必 await kill() 清 chrome 进程组，见 browser_tool §3.1）
            └─ runner Promise.any resolve(jina result)
T3  runner 返回 winner（不等 local 的 cleanup 完成）
T4  detached: local.cleanup().catch(()=>{})  // idempotent；dispatcher/浏览器已在 fetch finally 关
T4' detached: jina.cleanup().catch(()=>{})
```

**清理保证清单**（每个 fetcher 必须，即使输掉 race）：

| Fetcher | 资源 | 清理点 | Bun 兼容 |
|---|---|---|---|
| JinaContentFetcher | undici dispatcher（per-call） | proxyFetch 内部 finally：`if (typeof dispatcher.close === 'function') dispatcher.close()` | BUG-003 守卫 |
| LocalContentFetcher（静态分支） | undici dispatcher（per-call） | 同上 | BUG-003 守卫 |
| LocalContentFetcher（headless 子分支） | chrome 进程（一次性 node worker 内 playwright） | 一次性 worker 模型自带清理：正常路径 worker 在 emit 前 `await kill()`（killProcessGroup 清 chrome 进程树）；abort/超时 → driver 侧 killProcessGroup(worker child)（browser_tool §3.1） | 一次性 spawn→task→kill 模型，防孤儿 chromium |

清理本身 **best-effort、不抛、detached**（`.catch(()=>{})` 吞掉异常，不让 unhandled rejection 冒泡；但清理必须真执行——不能因为「输掉 race」就跳过）。

## 4. Layer 2 SSRF 防护（jina 之前必做）

**SSRF 三件套**（参考 hermes `website_policy.py` + openclaw loopback fail-closed）：
1. **IP 黑名单**：URL host → DNS 解析 → 命中私网/保留段（10/172.16/192.168/127/::1/169.254/...）→ 拒绝。
2. **DNS pinning**：校验 IP = 实际连接 IP（防 DNS rebinding）。`fetchWithRedirectGuard` 每跳 `resolveAndCheck` 取首个 IP → `proxyFetch` 的 `resolvedIp` 钉死 TCP 连接。实现 = `createPinnedDispatcher(resolvedIp)` 的 `connect.lookup` hook（忽略传入 hostname，固定返回已校验 IP）；**lookup 必须兼容 undici/node net 两种调用形态**：`opts.all===true`（autoSelectFamily Happy Eyeballs）→ `cb(null, [{address, family}])`（数组形态）；普通形态 `(_, cb)` / `(_, opts, cb)` → `cb(null, address, family)`。缺 all 形态时 Node runtime 抛 `Invalid IP address: undefined`（prod 实证）——pinned 语义不变（永远返首校验 IP，防 rebinding；family 按 `:` 判 4/6）。
3. **重定向逐跳校验**：每跳 3xx 重做 SSRF；**跨 origin 重定向剥 `Authorization`/`Cookie`**（防凭证泄漏到重定向目标）。

其他：禁 `file://`/`ftp://`；证书校验不关；总超时 ~30s（`AbortSignal.timeout`）；重定向 ≤10。

> **为何 jina 之前**：jina reader 收到 `r.jina.ai/<内部url>` 请求时，内部 URL 已泄漏给 jina。SSRF-first 把内部地址在本地挡掉，jina 只会收到通过校验的公网 URL。

## 5. Layer 1 代理（undici EnvHttpProxyAgent）

**所有出站 HTTP（含 jina 调用、自托管抓取、headless 起 chrome 的 Playwright 也建议读 proxy env）统一走 undici `EnvHttpProxyAgent`**。

**关键事实**：
- **Bun 原生 `Bun.fetch` 不读 `HTTP_PROXY`/`HTTPS_PROXY`**——必须用 undici。
- undici `EnvHttpProxyAgent` 自动解析 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（含 CIDR）。
- `NO_PROXY` 需支持 IPv4 CIDR（fake-ip 代理栈）。

**要点**：`allowH2:false`；per-call dispatcher 必须 close（**BUG-003**：Bun undici `close()` 可能不存在 → `typeof close==='function'` 守卫）；**代理失败不静默降级直连**（SSRF 形同虚设）。超时一律用 `AbortSignal.timeout`（**BUG-005**：Bun undici 忽略 dispatcher 的 `headersTimeout/bodyTimeout`）。

## 6. 设计决策

### 6.1 ContentFetcher 契约 + 2 实现（用户决策 v1.3 重构）
**结论**：抽象 `ContentFetcher` 接口，2 个实现——`JinaContentFetcher`（r.jina.ai）与 `LocalContentFetcher`（静态 + **内部 headless 子分支**）。race runner 构造注入共享 `AbortController` signal；首合格胜出 abort 其他；detached 清理。
**理由**：契约统一 = 新增实现（如未来 firecrawl/proxy pool）只需实现接口并注册，runner 零改动；headless 归 Local 内部 = 「Local 自己决定何时起 chrome」语义更内聚（v1.2 把 headless 放顶层兜底，与「Local 是本地路径」的概念割裂）；构造注入 signal = fetcher 从出生持有 abort，所有子操作一开始就接好，无后传时序窗口。
**反例**：(a) v1.2 三段式（jina ∥ local 顶层 + headless 顶层兜底）——headless 与 Local 概念割裂，且两路皆空才起 headless 串行等满；(b) signal 后传（fetch(ctxWithSignal)）——fetcher 构造到 fetch 调用之间若有子操作启动会漏接 abort。

### 6.2 AbortController 构造注入（用户决策 v1.3）
**结论**：race runner 创建一个共享 `AbortController`，**构造每个 fetcher 时把 signal 塞进构造参数**。
**理由**：fetcher 从出生持有 signal，内部所有子操作（jina fetch / 本地静态 fetch / local 起 headless chromium）一开始就接好 abort——胜出方 abort 时输方正在飞的所有子操作立即抛 AbortError，资源在 finally 释放。后传（fetch(ctx) 才拿到 signal）有时序窗口。
**反例**：每个 fetcher 自建 AbortController 互相引用（v1.2 现实现 ctrlA/ctrlB 互指）——耦合、难追踪、扩展第三者时接线爆炸。

### 6.3 detached 清理（用户强调，v1.3）
**结论**：胜出方 abort 输方后，主流程立即返回；输方 cleanup **detached**（best-effort、不抛、`.catch(()=>{})`），但**必须真执行**（关 dispatcher / 关 page+context+kill chrome）。
**理由**：主流程不因输方清理阻塞（用户拿到结果要快）；但清理必须保证——否则 dispatcher 泄漏 / chromium 孤儿进程堆积。`.catch(()=>{})` 吞异常防 unhandled rejection，**不是跳过清理**。

### 6.4 SSRF 在任何抓取之前（非妥协）
**结论**：SSRF 校验永远先于 jina/本地抓取。
**理由**：见 §4——防内部 URL 泄漏给 jina + 门禁对本地路径有效。

### 6.5 JS 渲染：jina 自带 + Local 内 headless 子分支（走 NodeWorkerDriver 一次性 render）
**结论**：JS 渲染主力靠 jina（并行 race 一路自带渲染）；Local 内部静态不足时起 headless chrome，生产实现走 browser 工具 **NodeWorkerDriver `executeOnce({headless:true}, 'render', {url})` 一次性渲染**（spawn node worker → `page.goto(url,{waitUntil:'domcontentloaded'})` → `page.content()` → kill chrome），不引第二条渲染栈。headlessRenderer 契约不变（`(url,signal)=>Promise<string>`，§3.3）。
**理由**：browser 工具 mode①② 已建 NodeWorkerDriver 一次性执行栈（绕 Bun connectOverCDP hang，见 `[P1]browser_tool.md` §3）；web_fetch headless 需求 = navigate + 取渲染 HTML 的一次性操作，与一次性 worker 模型天然匹配，无需 connect 长 session。driver 无 `executeOnce` → headlessRenderer 为 undefined，headless 子分支整体跳过（优雅降级，jina 兜底）。
**反例**：以 `driver.connect` 探测 headless 可用性（旧实现）——prod registry 注册的 NodeWorkerDriver 只有 executeOnce 没有 connect，headless 恒缺席，JS 渲染页（静态 403/内容空）彻底无路径。

### 6.6 Bun.fetch → undici（代理刚需）+ AbortSignal.timeout（BUG-005）
**结论**：抓取（含 jina）一律 undici `fetch` + `EnvHttpProxyAgent`；超时一律 `AbortSignal.timeout`（不用 undici dispatcher 超时）。
**理由**：Bun.fetch 不读代理 env；Bun undici 忽略 dispatcher 超时（BUG-005 实证）。

## 7. 共性约定（见 `[P1]web_tools.md` §2）

代理（undici）/ wrapExternalContent / 截断（~100k，走 context offload）/ 超时（`AbortSignal.timeout`，jina ~28s、自托管 ~30s、总 ~30s，合并进 raceSignal）/ 审批（敏感域名可 HITL）。

## 8. 边界

| 零件 | 归属 |
|---|---|
| web_fetch Tool + 管线（ContentFetcher 契约 + 2 实现 + race + abort 注入 + detached 清理 + onFailure 归因 + error.log）+ SSRF-before-jina + 决策 | 本文 ✅ |
| headless 渲染复用的 NodeWorkerDriver（executeOnce + worker render action）+ chrome 发现 | `browser_tool.md` §3 |
| 共性约定（代理统一口径/截断/包装/超时/审批） | `[P1]web_tools.md` §2 |
| 串行执行 + ToolResultBlock | `tool_execution_engine.md` |
| 截断后 context offload | `../../context/[P0]context_assemble_detail.md` |

## 9. 文件清单（当前实现）

| 文件 | 角色 |
|------|------|
| `app/server/src/tools/web-fetch/tool.ts` | web_fetch Tool 入口：run（SSRF → fetchContent → wrap/截断）；`buildHeadlessRenderer`（检测 driver.executeOnce 包装一次性 render）；`writeWebFetchErrorLog`（失败路径写 error.log） |
| `app/server/src/tools/web-fetch/content-fetcher.ts` | `ContentFetcher` 接口 + `FetchContext`/`FetchResult`（含 `err`）类型 |
| `app/server/src/tools/web-fetch/race-runner.ts` | `fetchContent` race 编排（构造注入 2 fetcher / Promise.any 首合格 abort / `onFailure` 归因透出 / detached cleanup） |
| `app/server/src/tools/web-fetch/jina-fetcher.ts` | `JinaContentFetcher`（r.jina.ai，Bearer if key，masked-key 观测日志） |
| `app/server/src/tools/web-fetch/local-fetcher.ts` | `LocalContentFetcher`（静态→headless 子分支；MIN_CONTENT=200；`HeadlessRenderer` 类型） |
| `app/server/src/tools/web-fetch/proxy.ts` | undici 代理层（EnvHttpProxyAgent / 直连 / `createPinnedDispatcher` lookup 双形态 / `proxyFetch`） |
| `app/server/src/tools/web-fetch/ssrf.ts` | `resolveAndCheck` / DNS pinning 校验 / 跨 origin 剥凭证 / `isLoopback*` |
| `app/server/src/tools/web-fetch/readability-extract.ts` | readability 提取 + htmlToMarkdown |
| `app/server/src/tools/web-fetch/merge-signal.ts` | 多 AbortSignal 合并 |
| `app/server/src/tools/web-fetch/mask-key.ts` | `maskKey` 纯函数（jina key 脱敏，与前端 maskSecret 同规则） |

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
