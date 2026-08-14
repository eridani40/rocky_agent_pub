# v0.0.334 tech change log — browser tool 简化（删 cdpUrl）+ 资源生命周期 sqlite 台账

> 对应需求：`reqs/[todo] v0.0.334.browser-tool-simplify-and-resource-lifecycle.md`（老板 2026-08-12 10:00-10:05 逐条拍板）。
> 权威契约：`specs/tech/version_logs/v0.0.334/change_plan.md`（A1-A15 + B1-B11 + U1-U7 method 级契约，frozen）。

## 变更摘要（T1/T2 已合并：03c0a7dbd + ac6c4103a + 54275e41e）

### 调查结论（chrome-devtools-mcp 1.4.0 无法 attach 时的行为）

源码实证（`node_modules/.bun/chrome-devtools-mcp@1.4.0/.../build/src/`）：

1. **autoConnect 机制**（`index.js` L75-82 + `browser.js` L47-109）：`--autoConnect` → channel 分支（channel 缺省 `'stable'` → puppeteer `connectOptions.channel='chrome'`）→ puppeteer.connect channel 分支（`third_party/index.js` L67240-67260）→ `resolveDefaultUserDataDir` 定位默认 user data dir → 读 `DevToolsActivePort` 文件 → `ws://localhost:<port><path>` 连 CDP。**无 URL 输入，纯自动连接**。
2. **未开调试态**：DevToolsActivePort 缺失 → puppeteer 抛 `Could not find DevToolsActivePort for chrome at <portPath>` → `browser.js` L109 包装为 `Could not connect to Chrome. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.`（autoConnect=true 含 inspect 引导）。
3. **版本 <144**：chrome-devtools-mcp **不检测 Chrome 版本**——远调模式是 144+ 能力，低版本无法开启调试态 → DevToolsActivePort 不存在 → 与「未开调试态」落同一个错，无版本提示。
4. **拒绝同意 prompt / 端口半开**：DevToolsActivePort 写了但 WS 连不上 → puppeteer.connect 抛 → 同样包装为 `Could not connect to Chrome...`。

**结论**：chrome-devtools-mcp 对「无法 attach」已统一报明确错误 + inspect 引导（非模糊 Could not connect），但**版本不足（<144）无针对性提示**。实现方向：connect 失败时**主动探测本机 Chrome 版本**（复用 chrome-discover 发现二进制 → `--version` 解析，新增 `chrome-version.ts`）——<144 → 明确「检测到 Chrome v<v>（<144），请升级 Chrome」；≥144 或探测失败 → 引导「开启/批准 remote debugging」。不 patch 上游包。

### Part A：删 cdpUrl + desc 简化 + 错误消息明确化（A1-A15）

- tool.ts schema 删 cdpUrl（剩 mode/action/profileName/url/ref/text）；desc 整体简化重写（attach 自动连接 + 前置条件 + 同意流程 + 失败引导 + 共享浏览器安全警告 + 模式路由）。
- SSRF 门禁段删除（无 URL 输入，SSRF 面消失）；web-fetch/ssrf.ts 本体保留（web_fetch 仍用）。
- chrome-mcp-driver buildChromeMcpArgs 删 browserUrl 分支固定 `--autoConnect`；session 缓存 key 删 cdpUrl 维度。
- types.ts BrowserConnectOptions/BrowserLaunchOptions 删 cdpUrl；attach-instance/attach-mode-impl/attach-debug-state 连锁（close 恒检测残留）。
- 新增 `chrome-version.ts`（detectChromeVersion）+ connect 错误消息版本差异化引导。

### Part B：资源生命周期 sqlite 台账（B1-B11）

- 新增 `instance-ledger.ts`（BrowserInstanceLedger）：sqlite 表 `browser_instances`（key/mode/profile_name/user_data_dir/cdp_port/worker_pid/chrome_pid/created_at），launch insert（INSERT OR REPLACE）/ close **硬删**（DELETE）/ 启动自检 listAll → clearAll；复用 `createSqlDriver`（dev=bun:sqlite / packaged=node:sqlite，不引新依赖），库文件 `<dataDir>/browser.sqlite`。
- attach 首次入台账（MCP 子进程 pid 经 McpTransport.pid 暴露）——孤儿 MCP 代理可被启动清理回收；AttachModeImpl 增 cleanupOrphan。
- instance-record.ts 重构（删 JSON 文件读写，保留 isPidAlive/killProcessGroupByPid/errMsg/toRecord）。
- bootstrap-connectors-phase 装配：`createSqlDriver(join(resolveDataDir(), 'browser.sqlite'))` → ledger → manager（deps 必填）。
- app 退出统一回收沿用 shutdown hook（releaseAll 全路径台账硬删）。

### 边界（req 已知缺陷，本版不做）

- 重启后 session 记忆幻觉（台账已删但 agent 以为有 instance）——后续版本优化，本版只保证清理干净。

## 关键文件（架构期产出）

| 文件 | 变更 |
|---|---|
| `specs/tech/version_logs/v0.0.334/change_plan.md` | **新增**（本文件权威契约：A1-A15 + B1-B11 + U1-U7，含调查结论 + sqlite schema） |
| `specs/tech/agent/tools/[P1]browser_tool.md` | 修改（删 cdpUrl + attach 仅 autoConnect + 版本引导 + SSRF 段删除 + desc 契约 + 锁定决策） |
| `specs/tech/agent/tools/[P1]browser_instance_manager.md` | 修改（台账表设计 + attach mcpPid + 启动清理/退出回收 + 文件清单） |
| `specs/api/overall/08-web-tools.md` | 修改（schema 删 cdpUrl + isError 分支 + 生命周期语义 + 版本尾注 1.6） |
| `specs/tech/config/[P1]connectors.md` | 修改（attach launch 注释删 cdpUrl） |
| `specs/tech/agent/tools/log.md` | 修改（v0.0.334 变更记录） |
| `states/v0.0.334/task.json` | **新增**（任务规划，3 tasks） |
| `states/v0.0.334/task-board.md` + `context.md` | **新增**（双轨状态初始化） |

## 实现核对（doc-modifier，T1/T2 已合并后核对）

| 计划项 | 实现一致性 |
|---|---|
| A1-A15 删 cdpUrl + desc 简化 + 版本引导 | ✅ tool.ts schema 剩 mode/action/profileName/url/ref/text；desc 重写含模式路由（我的 chrome→attach / 登录态→managed-profile / 默认→headless）+ 前置条件 Chrome ≥144 + 同意流程 + 失败引导 + 共享浏览器安全警告；`chrome-version.ts` 新增 detectChromeVersion（复用 chrome-discover 二进制 → `--version` 解析），connect 失败 <144 提示升级 / ≥144 或探测失败引导开启批准；SSRF 门禁段删除（web-fetch/ssrf.ts 本体保留） |
| B1-B11 sqlite 台账 | ✅ `instance-ledger.ts` 新增（BrowserInstanceLedger：`browser_instances` 表，key/mode/profile_name/user_data_dir/cdp_port/worker_pid/chrome_pid/created_at；launch INSERT OR REPLACE / close 硬删 DELETE / 启动 listAll→clearAll；复用 `createSqlDriver`，库 `<dataDir>/browser.sqlite`）；attach MCP 子进程经 McpTransport.pid 入台账；bootstrap-connectors-phase 装配 ledger→manager；退出沿用 shutdown hook releaseAll 全路径台账硬删 |
| U1-U7 UT | ✅ `bun run test` 零回归（coder 交付 + review 核对） |

**实现偏离（review 确认，语义不变）**：
- 死导出 `LedgerInstanceRecord` 已删 + instance-manager.test 注释更新为台账表述（T2 review Minor 修复，commit 54275e41e）。
- instance-record.ts 未整体删除——保留 `isPidAlive`/`killProcessGroupByPid`/`errMsg`/`toRecord` 供对账扫描复用，仅删 JSON 文件读写（change_plan B 组已声明「重构」而非删除）。

**验证**：AT/ET 按 `states/v0.0.334/test-plan.md`（attach 需老板交互时超时=算通过）。
