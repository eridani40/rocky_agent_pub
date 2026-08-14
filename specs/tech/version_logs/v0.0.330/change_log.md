# v0.0.330 tech change log — browser attach 修复（缺省 autoConnect + instanceKey 收敛 + close 调试态残留检测）

> 对应需求：`reqs/[working]/v0.0.330.browser-attach-fix.md`（leader 实测确认根因）。
> 权威契约：`specs/tech/version_logs/v0.0.330/change_plan.md`（Delta 1/2/3，method 级契约，frozen）。
> 纯技术改动（bug 修复 + 工具描述补全），跳 PRD（无用户可感知新交互）。

## 变更摘要

### 需求与动机

老板实测发现 attach 模式必挂 + ET 复验 blocking，三条线：

1. **attach 缺省 cdpUrl 被塞 9222（Delta 1 根因）**：`attach-instance.ts` 缺省 `cdpUrl ?? DEFAULT_ATTACH_CDP_URL` 把 undefined 塞成 `http://127.0.0.1:9222` → `buildChromeMcpArgs` 见 browserUrl 走 `--browserUrl` 分支 → chrome 144+ chrome://inspect 远调模式**不暴露 `/json/version`**（返 404 正常）→ 必挂。修复 = 缺省原样传 undefined → driver 走 `--autoConnect`（v0.0.34.1 HOTFIX 已实现的正确路径）。
2. **instanceKey 不一致（Delta 2，ET blocking）**：managed-profile 带 profileName → key=`sid:managed-profile:p1`，后续 navigate/close 不带 profileName → key=`sid:managed-profile` → 查表 miss → `no_browser_instance`。老板语义 = launch 一次性传初始化参数，之后只需 mode+action → instanceKey 三模式统一 `${sessionId}:${mode}`（profileName/cdpUrl 不进 key，由 handle 承载）。
3. **attach close 残留调试态（Delta 3，老板铁律「资源打开必须成对回收」）**：attach close 只断 MCP 连接，老板 Chrome 仍残留调试态（9222 监听 + 提示条）。实证 chrome-devtools-mcp / CDP **无编程关闭用户 Chrome 调试态的 API** → 对称回收我们开的资源（MCP 进程/连接/session 缓存）+ **检测残留 + 返回引导提示**（用户 chrome://inspect 取消勾选 / 重启 Chrome）。

### 方案（Delta 1/2/3 实现）

**Delta 1（60858bde2）— attach 缺省走 autoConnect + desc 三模式示例**：
1. `attach-instance.ts`：connect/disconnect 缺省 `cdpUrl ?? DEFAULT_ATTACH_CDP_URL` → 原样传 `cdpUrl`（undefined → driver 走 --autoConnect）；删 `DEFAULT_ATTACH_CDP_URL` import；文件头注释补语义（不塞 127.0.0.1:9222，该模式 /json/version 404 必挂）。
2. `chrome-mcp-driver.ts`：**删 `DEFAULT_ATTACH_CDP_URL = 'http://127.0.0.1:9222'` 常量**；文件头 flags 注释改（attach 缺省走 --autoConnect / 显式 cdpUrl → --browserUrl/--wsEndpoint）。
3. `tool.ts`：顶层 description 三模式写透（headless/managed-profile/attach 各自语义 + 流程铁律「必须先 launch 再 navigate/...；close 显式关闭」+ 每 mode JSON 调用示例）；mode/action/cdpUrl 字段 desc 同步（cdpUrl：缺省 autoConnect 自动连 chrome://inspect 远调模式；仅 --remote-debugging-port 显式启动时才传；loopback 豁免 SSRF，非 loopback fail-closed）。
4. `types.ts`：cdpUrl 注释同步。
5. 新增 `attach-instance.test.ts`（6 用例：缺省 autoConnect / 显式透传 / disconnect 对称 / 失败归类）。

**Delta 2（77d50c705）— instanceKey 收敛 sid:mode + launch/close 语义 + worker 构建机制**：
1. **D-A instanceKey 三模式统一**：`${sessionId}:${mode}`（删 managed-profile 分支；profileName/cdpUrl 不进 key，owner 天然隔离；attach key 现状已是 sid:attach 不变）。持久化旧格式记录（`sid:managed-profile:p1`）由开机自检 cleanupOrphans 按 rec.key 自洽收敛，无需迁移。
2. **D-B launch ready 复用文本用 handle 存的首次 profileName**：`reuse ${mode}(profile: p1)`（不读 opts.profileName——可能缺/不同）；`modeLabel` 只用 mode。同 session 同 mode 重复 launch（即使 profileName 不同）= 复用已有实例，不换 profile（老板语义；想换 profile 先 close 再 launch）。
3. **D-C close 无实例 → 明确报错**：`{ok:false, error:{kind:'no_browser_instance', message:'当前会话没有 {mode} 浏览器实例，请先调用 browser(action="launch")'}}`（不再静默 no-op）；有实例重复 close 仍幂等。
4. **D-D tool.ts desc 参数传递铁律**：launch 一次性传全部初始化参数（mode + profileName/cdpUrl）；创建后 navigate/snapshot/click/type/listPages/selectPage/evaluate/screenshot/close 只需 mode+action；profileName desc 改「mode=② 初始化参数（仅 launch 时传）」。未 launch 即操作或关闭 → 明确报错提示先 launch。
5. **D-E worker 构建机制**：`scripts/run-dev.sh` + `tests/api/env_start.sh` 启动前 `bun run build:worker`（幂等 ~1s）——browser-worker.cjs 产物每次 dev/ET/AT 前重建，保证 headless/managed 常驻协议最新（loop/chromePid）。
6. **D-F 产物出库**：`.gitignore` 加 `app/server/src/tools/browser/browser-worker.cjs` + `git rm --cached`（保留磁盘文件；库里旧 bundle 缺 loop/chromePid 协议误导）。

**Delta 3（b60c08196）— attach close 对称回收 + 调试态残留检测 + cleanup 脚本**：
1. **D3-A `ModeImpl.close` 返回类型** `Promise<void>` → `Promise<string | void>`（impl 可返回 close 提示文本；worker 无提示 undefined → manager 保持 'closed'）。
2. **D3-B attach close 升级**（attach-mode-impl.ts）：断 MCP 后调 `detectChromeDebugResidual()`（只读检测 9222/DevToolsActivePort）；残留 → 返回引导提示文本（chrome://inspect 取消 Allow remote debugging / 重启 Chrome）；显式 cdpUrl 不检测（用户自开边界）；检测失败降级无提示不阻断 close。
3. **D3-C 新增 `attach-debug-state.ts`**（116 行）：检测模块化——TCP 探测（netPortBusy）+ DevToolsActivePort 文件只读（darwin/linux/win 三平台候选路径）；判据保守不误报（文件缺失/探测失败/端口不可连 → 无残留）；依赖注入（probePort/readActivePort/home/platform）供 UT mock；不 kill/不写/不重启。
4. **D3-D closeInstance/close 透传 impl.close 返回文本**（releaseSession/releaseAll 同路径不丢提示；返回结构不变）。
5. **D3-E tool.ts desc 补 attach close 语义**：attach close = 断连接 + 检测 Chrome 调试态残留并提示；**不杀用户浏览器**；用户 Chrome 调试态（9222 监听/提示条）由 chrome://inspect 授权，需用户取消勾选 Allow remote debugging 或重启 Chrome 恢复。cdpUrl desc 补「显式 cdpUrl = 连接用户自开调试 Chrome（--remote-debugging-port），close 只断连接、调试态由用户管理」。
6. **D3-F 新增 `scripts/cleanup-chrome-debug.sh`**（68 行）：只读检测 9222 监听（lsof）+ DevToolsActivePort 位置 → 输出清理指引；**不自动 kill 用户 Chrome**（丢标签页/会话不可接受，违反 attach 语义红线）。

### 3 项 Minor 边界（review 确认，必须注明）

1. **releaseSession/releaseAll 的 close 提示文本无出口（API 为 void）**：`releaseSession`/`releaseAll` 返回 `void`，attach close 残留提示文本仅在 `close()`（BrowserExecuteResult.text）有出口；releaseSession/releaseAll 路径提示不丢失（经 closeInstance 透传）但调用方不展示——U8 测试已改名对齐（只断言 releaseSession 路径透传内部不丢，不断言用户可见出口）。
2. **attach-debug-state.ts 检测仅覆盖默认 user data dir**：DevToolsActivePort 候选路径只枚举默认 Chrome user data dir（darwin `~/Library/Application Support/Google/Chrome/` 等）；非默认目录 Chrome（`--user-data-dir` 自定义）漏报——**保守方向，不误报优先**（漏报 = 无提示，不阻断 close；误报 = 错误引导用户操作）。
3. **instance-manager.ts 行数微超 300 推荐线**：既有累积（v0.0.272 对账扫描等增量），非本版本新增——列入技术债，不拆分（拆分会破坏单文件内聚）。

### 回归保护与验证

- **UT（MANDATORY）**：
  - Delta 1：attach-instance.test.ts **6/6** + chrome-mcp-driver.test.ts **48/48** = 54/54 全绿；browser 目录全量 20 files / **293 passed** / 4 skipped
  - Delta 2：instance-manager.test.ts **43/43** 全绿；browser 目录全量 **297 passed** / 4 skipped；全量 UT **858 files / 10309 passed** / 4 skipped
  - Delta 3：attach-mode-impl + instance-manager + worker-mode-impl **83/83** 全绿（U7 close 残留检测两分支 + U8 close/releaseSession 透传 + U9 managed-profile close 对称断言）；全量 UT **858 files / 10316 passed** / 4 skipped
- **E2E（ET，等老板回来跑）**：browser 三模式真实调用（headless/managed-profile/attach 各 launch → navigate → close 全流程）；attach 需真 Chrome 远调模式；断言 attach 缺省不传 cdpUrl 能连上 + 显式 cdpUrl 仍走 --browserUrl + close 后 MCP 无残留。
- **机制验证**：dev 启动（run-dev.sh）/ ET env_start.sh 后 browser-worker.cjs 为最新构建（含 loop/chromePid 协议）；`git status` 确认 cjs 不再被跟踪。
- **显式 cdpUrl attach 保留**：仍走 --browserUrl/--wsEndpoint（L95-101 用例保留，用户自负 chrome 端点契约）。
- **headless/managed-profile 零改动**：Delta 1 只改 attach 路径；Delta 2 key 收敛后 execute/close 天然兼容（handle 已存全部资源）；Delta 3 worker close 对称断言锁定现状。

## 关键文件变更

### 后端（browser 工具）

| 文件 | 类型 | 说明 |
|------|------|------|
| `app/server/src/tools/browser/attach-instance.ts` | 修改 | 缺省 cdpUrl 原样传 undefined（driver 走 --autoConnect）；删 DEFAULT_ATTACH_CDP_URL import；头注释补语义 |
| `app/server/src/tools/browser/chrome-mcp-driver.ts` | 修改 | **删 `DEFAULT_ATTACH_CDP_URL` 常量**；flags 注释改 attach 缺省走 --autoConnect |
| `app/server/src/tools/browser/instance-manager.ts` | 修改 | instanceKey 三模式统一 `sid:mode`；launch ready 复用文本用 handle 首次 profileName；close 无实例报错 `no_browser_instance`；closeInstance 透传 impl.close 提示文本 |
| `app/server/src/tools/browser/tool.ts` | 修改 | 顶层 desc 三模式示例 + 参数传递铁律 + attach close 残留检测语义 + cdpUrl 边界 + profileName 仅 launch 传 |
| `app/server/src/tools/browser/types.ts` | 修改 | cdpUrl 注释同步（缺省 → driver 走 --autoConnect） |
| `app/server/src/tools/browser/mode-impl.ts` | 修改 | `ModeImpl.close` 返回类型 `Promise<void>` → `Promise<string \| void>` |
| `app/server/src/tools/browser/attach-mode-impl.ts` | 修改 | close 断 MCP 后调 detectChromeDebugResidual（Deps 注入）；残留 → 返回引导提示 |
| `app/server/src/tools/browser/attach-debug-state.ts` | **新增** | 调试态残留检测模块（TCP 探测 + DevToolsActivePort 只读；三平台候选路径；依赖注入） |
| `scripts/cleanup-chrome-debug.sh` | **新增** | 一次性清理指引（只读检测 9222 + DevToolsActivePort → 输出引导；不 kill 用户 Chrome） |
| `scripts/run-dev.sh` | 修改 | 启动前 `bun run build:worker`（幂等，保证协议最新） |
| `tests/api/env_start.sh` | 修改 | 启动前 `bun run build:worker`（ET/AT 前重建） |
| `.gitignore` | 修改 | 加 `app/server/src/tools/browser/browser-worker.cjs`（产物出库，git rm --cached 保留磁盘文件） |

### 测试

| 文件 | 类型 | 说明 |
|------|------|------|
| `app/server/src/tools/browser/__tests__/attach-instance.test.ts` | **新增** | 6 用例：缺省 autoConnect / 显式透传 / disconnect 对称 / 失败归类 |
| `app/server/src/tools/browser/__tests__/instance-manager.test.ts` | 修改 | U1 key 断言（新格式 sid:mode）+ U2 launch(p1) 后 execute 不带 profileName + U3 launch(p2) reuse 不换 profile + U4 close 无实例报错 + U5 attach close 幂等报错 + U6 持久化记录 key 新格式 + U8 close/releaseSession 透传 impl 文本 |
| `app/server/src/tools/browser/__tests__/attach-mode-impl.test.ts` | 修改 | U7 close 残留检测两分支（residual true/false + 显式 cdpUrl 不检测） |
| `app/server/src/tools/browser/__tests__/worker-mode-impl.test.ts` | 修改 | U9 headless/managed close 对称断言（kill+releasePort+unpersist；managed 不删 userDataDir 持久语义；impl.close 抛错兜底删表） |
| `app/server/src/tools/browser/__tests__/chrome-mcp-driver.test.ts` | 修改 | 删 DEFAULT_ATTACH_CDP_URL 引用；显式 cdpUrl → --browserUrl 用例保留 |

## 偏离记录（change_plan 契约 vs 实际）

- **Delta 1**：change_plan 红线「driver/dispatch 零动」——reviewer 发现 DEFAULT_ATTACH_CDP_URL 已成死代码后裁决**本轮删常量**（连带 chrome-mcp-driver.ts 注释更新），driver 行为零动（未违反红线语义）；`autoConnect:boolean` 入参保留（兼容 UT + 未来切换）。
- **Delta 3**：`detectChromeDebugResidual` 签名与 change_plan 略有出入（实际读**用户 Chrome user data dir** 的 DevToolsActivePort，env.dataDir 保留对齐签名但 void 不使用）；检测依赖经构造注入（`constructor(detectDeps = {})`）供 UT mock——均报 leader 确认后落地。
- **3 项 Minor 边界**（见上节，review 确认落档）：releaseSession/releaseAll close 提示文本无出口 / attach-debug-state 仅默认 user data dir / instance-manager.ts 行数微超 300。
