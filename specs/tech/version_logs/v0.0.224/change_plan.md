# v0.0.224 change_plan — web_fetch 全挂修复

> 8 列：模块 / 文件 / 函数·符号 / 类型 / 变更内容 / 约束 / 参考 / 影响行
> 根因实证见 `reqs/[working] v0.0.224.web_fetch_issue/ROOT_CAUSE.md`

## 背景（一句话）
prod（Electron/Node runtime）web_fetch 全挂：① `createPinnedDispatcher` lookup 未实现 undici `options.all` 形态 → Node 抛 `Invalid IP address: undefined`，local 静态路必挂；② headless 兜底被 NodeWorkerDriver（无 connect 长 session）连带砍掉，JS 渲染页无路径；③ jina 局部超时/内容不足。修复目标 = 对用户做好的模式：静态路修活 + headless 渲染真正接回 + 失败接 error.log。

## 变更契约

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|---------|------|------|--------|
| web-fetch/proxy | `app/server/src/tools/web-fetch/proxy.ts` | `createPinnedDispatcher` 内 `lookup` | 修改 | lookup 兼容 undici 两种调用形态：`options.all` 为 true → `cb(null, [{address, family}])`；否则 → `cb(null, ip, family)`。保留既有 `(host, cb)` / `(host, opts, cb)` 形参归一逻辑 | 不改变 pinned IP 语义（永远返首校验 IP，防 rebinding）；family 仍按 `:` 判 4/6 | ROOT_CAUSE §1；undici/node `net` lookup 契约（all:true → array 形态）；实证 prod asar 编译产物 FAIL `Invalid IP address: undefined` | proxy.ts ~78-102 |
| web-fetch/tool | `app/server/src/tools/web-fetch/tool.ts` | `buildHeadlessRenderer` | 修改 | 改走「一次性 render」：检测 `driver.executeOnce`（NodeWorkerDriver 支持）而非 `driver.connect`；renderer(url,signal) 内部 `executeOnce({headless:true},'render',{url},signal)` → 解析 result.text(=渲染后 HTML)。无 executeOnce → undefined（保留优雅降级） | headlessRenderer 契约不变 `(url,signal)=>Promise<string>`；NodeWorkerDriver executeOnce 一次性 spawn 模型；Bun 下 connectOverCDP hang 走 node worker（既有） | spec §3.3 headless 子分支；node-worker-driver.ts executeOnce；v0.0.23.1 注释（NodeWorkerDriver 无 connect） | tool.ts ~184-214 |
| browser/worker | `app/server/src/tools/browser/worker-entry.ts` | `dispatchAction` + `case 'render'` | 新增 | 新增一次性 `render` action：`page.goto(url,{waitUntil:'load'})` → `page.content()`（=渲染后 outerHTML）→ 返回 HTML 字符串。随后 `bun run build:worker` 重生成 `browser-worker.cjs`（dev 用 bundle） | 一次性 worker 模型（spawn→task→result→kill）；playwright external require；不引入 bun-only API | worker-entry.ts dispatchAction §evaluate；playwright-session.ts | worker-entry.ts ~119-181；browser-worker.cjs 重生成 |
| browser/worker | `app/server/src/tools/browser/node-worker-driver.ts` | `resolveWorkerPath` | 修改 | packaged 路径修复（bug C）：优先用 `dist` 同目录 `worker-entry.js`（tsc 编译产物，packaged 真实命中且存在，require `./chrome-launcher`/`./snapshot-ref`/`playwright` 均可解析）；不存在则退回 `browser-worker.cjs`（dev bundle，__dirname=src 时命中）。判定走 `existsSync` 探测 | 不改 worker 通信协议（stdin task/stdout result）；worker-entry.js 与 browser-worker.cjs 同源（worker-entry.ts）行为一致 | 实证：packaged dist/ 无 browser-worker.cjs → spawn ENOENT；browser 工具在 prod 也因此坏（无用户用过故无报错，顺带修复）；asar 含 playwright+playwright-core | node-worker-driver.ts ~267-272 |
| web-fetch/tool | `app/server/src/tools/web-fetch/tool.ts` | `run` 失败路径 + `writeWebFetchErrorLog` | 新增 | web_fetch 返 isError 前写 `LogWriter('error')`：url / 阶段（ssrf/race/各 fetcher）/ source / 失败原因。复用 `ctx.config.logWriter`（鸭子类型，开关 enableErrorLog 控制，缺省 no-op） | 失败静默（不阻塞工具返回）；不泄 jina key；record 字段对齐 error.log JSONL 一行 | log-writer.ts write('error')；engine.ts writeToolLog 模式；用户「即便修复不成也可看日志」 | tool.ts run ~139-147 + 新增 helper |
| web-fetch/race-runner | `app/server/src/tools/web-fetch/race-runner.ts` | `fetchContent` 失败归因 | 修改 | 两路皆空（winner=null）时收集各 fetcher 失败原因（jina/local 各自 ok:false 的 err/status）随 null 一并透出（或经回调），供 tool 层写 error.log 定位是哪一路为何挂 | 不改 race 语义/合格判定；归因仅观测用途 | ROOT_CAUSE §3；race-runner.ts:111-117 | race-runner.ts ~98-127 |

## UT 变更

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|---------|------|------|--------|
| web-fetch/__tests__ | `__tests__/proxy-pinning.test.ts` | lookup options.all 形态用例 | 新增 | 新增用例：`lookup('host', {all:true}, cb)` → 断言 `cb(null, [{address, family}])`；锁死修复（现 UT 只测无 all 形态，是漏检根源） | 不真联网（mock undici Agent 捕获 lookup） | proxy-pinning.test.ts:48-101 | proxy-pinning.test.ts 新增 describe |
| web-fetch/__tests__ | `__tests__/tool.test.ts` 或 `local-fetcher.test.ts` | headless renderer 走 executeOnce | 新增 | mock driver.executeOnce 返渲染 HTML → 断言静态不足时 headless 子分支触发且 source='headless'；无 executeOnce → 跳过 | mock，不起真 chrome | local-fetcher.test.ts 现有 headless 用例 | 视文件定 |
| browser/__tests__ | `__tests__/worker-entry.test.ts`（若有） | render action | 新增 | dispatchAction 'render' → 返回 HTML（mock page.goto/content） | mock page，不起真 chrome | worker-entry.ts | 视文件定 |

## 不做（本版本范围外）
- jina 超时调优（jinaTimeoutMs 默认值）—— 局部超时属用户网络 + jina 服务端，非代码 bug；headless 接回后 JS 页由 local/headless 兜底。
- headless 长 session（connect 模型）—— 一次性 render 已覆盖 web_fetch 取 outerHTML 需求，无需长 session。
- web_search / browser tool 行为变更 —— 仅 web_fetch 链路 + resolveWorkerPath 顺带修 browser 工具 packaged 路径。

## 打包护栏自检（packaged 专属）
- 无新增第三方依赖（playwright 已 external，asar 含 playwright+playwright-core ✓）；`browser-worker.cjs` 由 `bun run build:worker` 重生成（dev bundle）；packaged 命中 `dist/worker-entry.js`（tsc -b 产物，build-dmg ①a 已 build server）。
- 无新增必需运行时 env 键；无相对路径/字面 `~`。
- **packaged 验证（MANDATORY）**：解包 asar 起真后端，curl web_fetch 打 baike（静态路）+ 一个 JS 渲染页（headless 路），确认非「无充足内容」；并确认 `dist/tools/browser/worker-entry.js` 存在（resolveWorkerPath packaged 命中）。
