# v0.0.226 change_plan — web_fetch render 参数 + render waitUntil 修

## 背景
v0.0.225 后分析：render action waitUntil:'load' 对持续加载页面超时（ixdzs8 load 不触发，domcontentloaded 1.5s 够）；local 静态≥200字误判导致 JS 渲染页正文漏。加 render 参数让 LLM 强制渲染。

## 变更契约（8 列）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|---------|------|------|--------|
| browser/worker-actions | app/server/src/tools/browser/worker-actions.ts | case 'render' | 修改 | page.goto waitUntil 'load'→'domcontentloaded'（load 对持续加载页面超时；domcontentloaded 后 DOM 就绪 JS 渲染内容已在） | 一次性 worker 模型；WORKER_TIMEOUT_MS=30s 上限不变 | 实证：ixdzs8 load 超时 20s+，domcontentloaded 1.5s | worker-actions.ts render case |
| web-fetch/tool | app/server/src/tools/web-fetch/tool.ts | WebFetchInput + run | 修改 | inputSchema 加 render?:boolean（强制 headless 渲染）；run 内 render=true → 构造强制 headless 的 fetchContent 选项（跳过静态直起 headless，local 整路走 headlessRenderer） | 现有 url/maxChars 不变；render 缺省=false 现有行为不变；render=true 时即使静态能拿也走 headless | web_fetch_tool.md §2 inputSchema + §3.3 | tool.ts WebFetchInput + run |
| web-fetch/race-runner | app/server/src/tools/web-fetch/race-runner.ts | fetchContent options | 修改 | FetchContentOptions 加 forceHeadless?:boolean；true 时 local fetcher 跳过静态直起 headless（或 local 不参与只 headless+jina） | race 语义不变（jina ∥ local）；forceHeadless 仅影响 local 内部静态/headless 选择 | race-runner.ts FetchContentOptions + local-fetcher | race-runner.ts + local-fetcher.ts |

## spec（概念先行）
specs/tech/agent/tools/[P1]web_fetch_tool.md：
- §2 inputSchema 加 render?:boolean（描述：强制 headless 渲染，用于已知 JS 页或静态内容不全时）
- §3.3 LocalContentFetcher：render=true 时跳过静态分支直起 headless

## UT
- worker-actions render：mock page.goto 断言 waitUntil='domcontentloaded'（非 load）
- tool.ts：render=true → fetchContent 收到 forceHeadless=true；render 缺省 → false
- local-fetcher：forceHeadless=true → 跳过静态直起 headlessRenderer

## 打包护栏
- 改 worker-actions.ts 需 bun run build:worker 重生成 browser-worker.cjs
- 无新依赖；render 参数纯 inputSchema 扩展
