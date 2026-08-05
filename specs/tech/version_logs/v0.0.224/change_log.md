# v0.0.224 change_log — web_fetch 全挂修复（lookup bug + headless 接回 + packaged worker 路径 + error.log）

> method 级变更契约见同目录 `change_plan.md`（6 行）；根因实证见 `reqs/[working] v0.0.224.web_fetch_issue/ROOT_CAUSE.md`。

## 背景

prod（dmg/Electron，Node runtime）下 web_fetch 对全部 URL 返「所有抓取路线均无充足内容」。实证 4 bug：

- **bug A — lookup**：`createPinnedDispatcher` 的 lookup 未实现 undici `options.all` 形态 → Node 抛 `Invalid IP address: undefined`，local 静态路必挂（dev Bun 不触发，仅 prod Node runtime）。
- **bug B — headless 缺席**：`buildHeadlessRenderer` 检测 `driver.connect`，但 prod registry 注册的 NodeWorkerDriver 只有 `executeOnce` → headlessRenderer 恒 undefined，JS 渲染页无路径。
- **bug C — packaged worker 路径**：`resolveWorkerPath` 命中 `dist/.../browser-worker.cjs`（不存在，tsc 不拷 .cjs 进 dist）→ spawn ENOENT；browser 工具 mode①② 在 prod 也因此坏（无用户用过故无报错，顺带修复）。
- **bug D — error.log**：web_fetch 失败无任何日志，无法归因。

## 变更摘要

1. **`web-fetch/proxy.ts` `createPinnedDispatcher` lookup**：兼容 undici 两种调用形态——`opts.all===true` → `cb(null,[{address,family}])`；否则 → `cb(null,ip,family)`。pinned 语义不变。
2. **`web-fetch/tool.ts` `buildHeadlessRenderer`**：检测 `driver.executeOnce`（非 connect）→ `executeOnce({headless:true},'render',{url},signal)` 一次性渲染；无 executeOnce → undefined 优雅降级。headlessRenderer 契约 `(url,signal)=>Promise<string>` 不变。
3. **`browser/worker-actions.ts`（新文件）**：`dispatchAction` 从 worker-entry.ts 拆出（worker-entry 模块级 `void main()` 有副作用不能 UT import；本模块无副作用纯函数可 UT）；新增 `render` action（`page.goto(url,{waitUntil:'load'})` → `page.content()` 返回渲染 HTML，web_fetch headless 专用，不经 browser Tool inputSchema）。`browser-worker.cjs` 经 `bun run build:worker` 重生成。
4. **`browser/node-worker-driver.ts` `resolveWorkerPath`**：双路径 existsSync 探测——优先同目录 `worker-entry.js`（tsc 产物，packaged dist/ 命中），否则 `browser-worker.cjs`（dev bundle）。
5. **`web-fetch/tool.ts` run 失败路径 + `writeWebFetchErrorLog`**：三类失败（SSRF/race 抛错/两路皆空）写 `LogWriter('error')`（tool/url/stage/reason/failures?），鸭子类型 `ctx.config.logWriter`，`enableErrorLog` 开关在 LogWriter 内部，日志失败静默。
6. **`web-fetch/race-runner.ts` `fetchContent`**：两路皆空时经 `options.onFailure` 透出 `[{fetcher,reason}]`（Promise.any AggregateError 归集；`FetchResult` 新增可选 `err` 字段承载各 fetcher 失败原因）。

## Spec 同步

- `agent/tools/[P1]web_fetch_tool.md`：§1/§2/§3.1/§3.3/§3.4/§3.5/§4/§6.5/§8/§9 同步上述现状（§9 陈旧 v1.2→v1.3 重写清单替换为当前文件清单；§3.1 FetchContext 对齐代码实际 = {url}）。
- `agent/tools/[P1]browser_tool.md`：§3.1/§3.3/§3.7/§10 同步（worker-actions.ts + render action + resolveWorkerPath 双路径）。
- `dev-logs/[P0]overall.md` §3.6：error.log 新增工具层注入点（web_fetch）。

## 验证

- typecheck PASS + `bun run test` 8990 passed（新增 UT +13，含 lookup all 形态 / render action / resolveWorkerPath 双路径 / headless 子分支 executeOnce）。
- dev(Bun) 真实抓取 6/7 修复 OK；headless 渲染路接通（静态 403 → headless 4.4s）；error.log 落盘实证（失败归因 jina 422 + local 失败）。
- packaged 实证：解包 dmg asar，dist 产物含全部修复；resolveWorkerPath 命中 `dist/tools/browser/worker-entry.js`；render action headless chrome 真起 OK；tool 层端到端 3 URL 全 OK。
