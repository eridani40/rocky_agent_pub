# v0.0.225 change_log — web_fetch headless 诊断 + chrome-discover glob + jina timeout

> method 级变更契约见同目录 `change_plan.md`（3 行）；本版本为纯技术诊断修复（无用户可感知行为/界面变化），无 PRD 参与。

## 背景

v0.0.225 修复后 prod baike 仍失败：error.log 显示「headless 渲染失败」但笼统无法定位根因；排查期间另锁定两个确凿问题（chrome-discover ls glob bug + jina 20s timeout 对大页不够）。三处均为小改动，代码已 PASSED（typecheck + 全量 UT）。

## 变更摘要

1. **`browser/chrome-discover.ts` `listChromiumDirs`**：用 `readdirSync(ms-playwright).filter(name => name.startsWith('chromium-'))` 列版本目录 + 拼路径 `existsSync` 验证，替代 `execFileSync('ls',[glob])`——`execFileSync` 不经 shell，`ls` 收到字面 glob 不展开=坏（目录列表恒空，playwright chromium 候选静默缺席）。`DiscoverDeps` 加 `readdir?: (p:string)=>string[]` 注入字段（UT mock）。三级 fallback 顺序（用户配置 > 系统默认 > 硬编码+playwright）不变。
2. **`web-fetch/jina-fetcher.ts` `DEFAULT_JINA_TIMEOUT_MS`**：20_000 → 28_000（≤ race 总超时 `OVERALL_TIMEOUT_MS` 30s，留 2s 余量；原 20s 对大页 jina 渲染不够，race 输给 local 后 error.log 只见 jina 超时）。race 总超时 30s 硬上限不动。
3. **`web-fetch/local-fetcher.ts` `fetchHeadless`**：headlessRenderer 抛错时捕获真实 `e.message`（`chrome_not_found` / worker stderr / abort 等）透出到 `FetchResult.err`，不再笼统吞成「headless 渲染失败」。新增 `HeadlessOutcome.err?: string` 字段承载；`fetch` 把 `headless 渲染失败：${err}` 拼进 `localFail` 的 err 组合归因。headless 触发条件（静态 trim ≤ MIN_CONTENT 才起）+ headlessRenderer 契约不变。

## Spec 同步

- `agent/tools/[P1]browser_tool.md §3.5`：补 Playwright 缓存枚举机制现状（readdirSync + existsSync，弃 execFileSync ls glob；两 arch 候选；DiscoverDeps.readdir 注入）。
- `agent/tools/[P1]web_fetch_tool.md §3.2`：构造注 jinaTimeoutMs~20s→~28s；关键注补 28s 由来（≤ race 30s 留 2s 余量）。
- `agent/tools/[P1]web_fetch_tool.md §3.3`：伪码补 fetchHeadless try/catch + headlessReason 透出真实 error；关键注补 HeadlessOutcome.err 承载。
- `agent/tools/[P1]web_fetch_tool.md §7`：共性约定 jina ~20s→~28s。
- `agent/tools/log.md`：追加 v0.0.225 一条（per-KB 位置轴）。

## 验证

- typecheck PASS + `bun run test` 全量绿（chrome-discover readdirSync mock UT / local-fetcher headless err 透出 UT）。
- 无 API/UI 契约变化（纯内部机制修复），AT/ET 不受影响。
