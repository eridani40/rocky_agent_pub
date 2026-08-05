---
type: spec
title: Web Tools 体系总览
priority: P1
status: active
updated: 2026-06-30
since: v0.0.23
---

# Web Tools — 体系总览

web 工具让 agent 访问网络：**web_search**（检索）/ **web_fetch**（抓取单 URL → 干净正文）/ **browser**（chrome 自动化，三模式）。
三工具均由 `tool_execution_engine` 串行调度（见 `[P0]tool_execution_engine.md`）；`Tool[]` 由 `SessionConfig.tools` 持有（见 `index.md §①`），均注册于 `defaultTools()`（`app/server/src/tools/registry.ts`）。
调研依据：`specs/research/v0.0.23-web-search.md` / `v0.0.23-web-fetch.md` / `v0.0.23-browser-use.md`。

## 1. 概述

```
tools/  (本 KB 子目录)
├── index                   ← 工具体系总起（5 章）
├── tool_execution_engine   ← 串行执行引擎
├── file_op_tools / bash_tools
├── web_tools               ← 本文：三工具定位 + 共性约定 + 子文档索引
├── web_search_tool         ← web_search 协议 + exclusive EP + Zhipu provider
├── web_fetch_tool          ← web_fetch ContentFetcher 契约 + 2 实现 race
├── browser_tool            ← browser 三模式 + BrowserDriver 抽象
├── task_tools / agent_tools ← 派生/编排（task 实现迁 squad）
```

三工具定位：

| 工具 | 一句话 | 范围 |
|---|---|---|
| `web_search` | 按 query 检索，返回结构化结果列表（+可选 answer）。**协议先行 + exclusive EP**，后端 provider 可插拔 | 定协议 + EP + **内置 Zhipu provider**（ext impl；凭证 v0.0.72 起走 `app_config.web_search` group，不进 ext impl configSchema）；其他后端后续插件贡献 |
| `web_fetch` | 抓取单个 URL → 系统代理 → SSRF 校验 → **2 个 ContentFetcher 实现 race**（`JinaContentFetcher` ∥ `LocalContentFetcher` 含 headless 子分支，首个合格者胜）→ markdown | 完整实现（ContentFetcher 契约 + 2 实现 + 共享 AbortController 构造注入 + detached 清理 + SSRF）；引入 jina reader 作为一路 |
| `browser` | chrome 自动化：headless / 启动持久 profile / attach 已开 chrome | 三 mode 完整 + 统一 `BrowserDriver`/`BrowserSession` 协议抽象（接受 attach 驱动分裂）+ **attach 受连接器门禁**（`connectorManager.isReady('browser')`） |

## 2. 共性约定（spec 固化，三工具共享）

1. **系统代理**：所有出站 HTTP（web_fetch 抓取、web_search provider 的 HTTP 调用、browser 下载）走 **undici `EnvHttpProxyAgent`**（读 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`）。**禁止用 `Bun.fetch`/裸 `fetch` 直连**——Bun 原生 fetch 不读代理环境变量（见 `web_fetch_tool.md` §3）。
2. **不可信内容包装（wrapExternalContent）**：web 抓回的正文 / search snippet / answer 一律用统一包装标记「untrusted external content」，防 prompt injection。详见各子文档。
3. **过大响应截断**：单工具结果超阈值（web_fetch ~100k chars、search 默认 top-10）→ 截断 + 提示「走 context offload」（见 `../../context/[P0]context_assemble_detail.md`）。
4. **超时 / 取消**：工具从 `ToolCtx.signal` 接 AbortSignal；provider/抓取层自带默认超时（web_fetch ~30s、search provider 自带）。
5. **SSRF 防护**：web_fetch 必做（IP 黑名单 + DNS pinning + 重定向逐跳校验）；browser attach 远程 CDP 也做 loopback 私网 fail-closed（见 `browser_tool.md`）。
6. **审批（HITL）**：browser 的 attach 模式（操作用户真实浏览器/已登录态）、web_fetch 跨域敏感站点 → `needsApproval` 可按 input 判定（见 `tool_execution_engine.md` §5）。

## 3. 设计决策（总览级）

### 3.1 web_search 是「协议 + exclusive EP」，不绑死后端
**结论**：web_search 定义 `WebSearchProvider` 契约 + `web_search_provider` 扩展点（cardinality=`exclusive`，group=`web`）。同一时刻最多一个 provider 生效（用户配置选）。**v0.0.23 内置 Zhipu provider**（开箱 ext impl，凭证走 ext impl configSchema）；其他后端（Tavily/Google/Bing）后续以插件 ext impl 贡献，协议不变。
**理由**：搜索后端是可变商业依赖（凭证/计费/配额各异），焊死会绑死；exclusive 而非 list——一次搜索由一个 provider 答，非并发融合（结果可解释 + 凭证隔离）。详见 `web_search_tool.md`。
**反例**：claude-code 把 web_search 绑死 Anthropic 原生 server tool（`refs/claude-code/.../WebSearchTool.ts`），不可换后端，不适配我们的可插拔目标。

### 3.2 web_fetch ContentFetcher 契约 + 2 实现 race（用户决策 v1.3 定稿）
**结论**：web_fetch 管线 = SSRF 校验（任何抓取之前必做）→ **抽象 `ContentFetcher` 契约**（接口），**2 个实现并行 race**：`JinaContentFetcher`（`r.jina.ai/<url>`，自带 JS 渲染，`web.jinaApiKey` 有则传无则不传） ∥ `LocalContentFetcher`（**含 headless 子分支**：本地静态 readability 不足时内部起 Playwright 渲染）。race runner **共享 AbortController 构造注入**每个 fetcher；`Promise.any` 取首个「合格」（ok 且 trim 正文 ≥ ~200 chars）者胜 → `controller.abort()` 取消另一个 → 主流程立即返回；输方 **detached 清理**（关 dispatcher / 关 page+context+kill chrome，best-effort 不抛但必执行）。`web.jinaEnabled=false` 不构造 JinaContentFetcher。**SSRF 强制在任何抓取之前**（防内部 URL 泄漏给 jina）。
**理由**：契约统一 = 新增实现（firecrawl/proxy pool）只需实现接口，runner 零改动；**headless 归 Local 内部**（撤回 v1.2「两路皆空串行 headless 兜底」）= 「Local 自己决定何时起 chrome」语义内聚，消除 v1.2 headless 与 Local 概念割裂；**AbortController 构造注入**（撤回 v1.2 ctrlA/ctrlB 互指）= fetcher 从出生持有 abort，所有子操作（jina fetch / 本地静态 / local 起 chromium）一开始就接好，无后传时序窗口。
**Bun 兼容防回归**：BUG-003（undici `close()` 在 Bun 不存在 → `typeof close==='function'` 守卫）；BUG-005（Bun undici 忽略 dispatcher 超时 → 用 `AbortSignal.timeout`）。
**（撤回 v1.0「jina 优先串行 + 自托管兜底」——v1.2 改并行 race → v1.3 改 ContentFetcher 契约 + 构造注入 + headless 归 Local；亦撤回 v1.0「不引入第三方 reader」——jina reader 已引入。）** 详见 `web_fetch_tool.md`。

### 3.3 browser 三 mode 完整 + 统一抽象 + attach 受连接器门禁
**结论**：模式 1/2（headless / 持久 profile）用 Playwright（CDP）；模式 3（attach 已开 chrome）复刻 openclaw 的 `chrome-devtools-mcp`（chrome 144+ inspect 页开关）—— `ChromeMcpDriver`。两栈驱动分裂不可避免，**抽象 `BrowserDriver`/`BrowserSession` 统一协议层**——调用方只见 `browser` 工具 + mode，操作集一致；底层分裂封装在 driver 内。`snapshot` 统一返回 `{snapshot, refs}`（a11y + ref）是「驱动模型统一」的落点。
**mode①② driver = NodeWorkerDriver**：Bun 运行时下 `playwright.connectOverCDP()` 永久 hang（oven-sh/bun#9357），故 mode①② 的 playwright 操作走 **node 子进程一次性执行器**（`NodeWorkerDriver.executeOnce` → spawn `node browser-worker.cjs` → worker 内 connectOverCDP + dispatch + cleanup）。`BrowserDriver` 加可选 `executeOnce`（mode①② 用），`connect` 仅 mode③ attach 用（长会话）。详见 `browser_tool.md` §2/§3/§7。
**attach 门禁**：mode ③ run 内前置 `if (!connectorManager.isReady('browser')) return 引导错误`——用户必须先在「连接器 → 浏览器」中 toggle on 并 connected 才能调 attach。mode①②不查连接器。

### 3.4 group 新增 `web` 分区
**结论**：新增 EP group=`web`（承载 `web_search_provider`，未来 web_fetch/browser provider 同 group）。group 是 EP 必填字段（见 `../../../plugin_system/[P0]extension_point_interface.md` §3.6），仅用于配置 UI 分组，不影响运行时。

## 4. 边界

| 零件 | 归属 |
|---|---|
| 三工具定位 + 共性约定 + 子文档索引 + 总览决策 | 本文（web_tools）✅ |
| web_search 协议 + EP + Tool 层 + Zhipu provider | `web_search_tool.md` |
| web_fetch 管线（并行 race + headless 兜底）+ SSRF + 代理 | `web_fetch_tool.md` |
| browser 三模式 + chrome 发现 + profile 持久化 + attach + a11y/ref + 连接器门禁 | `browser_tool.md` + `connectors.md` |
| 串行执行 / resolve / 超时 / 审批 | `tool_execution_engine.md` |
| Tool[] 持有（SessionConfig.tools）+ 工具清单 | `index.md` |
| ExtensionPoint cardinality/group 语义 | `plugin_system/extension_point_interface.md` |

## 5. 已闭环的开放问题（汇总）

> 全部已决议（细节见各子文档 + 用户决策记录）：
> 1. ~~**browser attach 驱动分裂**~~ → **已接受**（MCP(③) + Playwright(①②) 两栈驱动 + `BrowserDriver`/`BrowserSession` 统一抽象）。
> 2. ~~**browser 反检测**~~ → **不做**（camofox 路线复杂易失效）。
> 3. ~~**browser 截图+坐标**（computer-use）~~ → **不做**（下一阶段，主用 a11y tree + element ref）。
> 4. **browser profile 占用冲突** → 报错 + 提示，**不抢锁不排队**；远程 attach cdpUrl loopback 私网 fail-closed；attach 不做 token 鉴权（单机本地）；chrome-devtools-mcp 用 `@latest`（不钉死）。
> 5. ~~**三工具优先级与裁剪**~~ → **三工具全做**（不分期）。

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
