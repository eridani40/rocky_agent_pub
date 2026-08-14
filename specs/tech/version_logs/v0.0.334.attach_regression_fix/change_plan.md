# v0.0.334 回归修复 change_plan：attach 连不上 + attach 计数虚高

> 架构期冻结契约。改 v0.0.334 已合并代码（dev1）的回归缺陷，走精简流程。coder 按此实现，reviewer 按此查偏离。
> 上游：leader（Darvin）2026-08-12 12:21 派单，根因已由 leader 代码实证 + 实测定论；本文档落成 method 级方案。
> 边界：只修这两个 bug；不改 334 已定的删 cdpUrl / desc 简化 / 生命周期主逻辑；复用现有 `devToolsActivePortCandidates`，不发明新路径逻辑。

## 背景与根因（已实证，非推测）

334 删了 cdpUrl，attach 只走 `--autoConnect`。老板实测「attach 根本没 work」。两个**独立** bug：

### Bug 1：attach 连不上（删 cdpUrl 引入的回归）

**代码实证**：
- `chrome-mcp-driver.ts` `buildChromeMcpArgs`（:269-280）：`--userDataDir` 只在 `input.userDataDir` 非空时才加。attach 时 `connectAttachSession` 调 `driver.connect({})`（attach-instance.ts:44，**空 opts**）→ `userDataDir=undefined` → 不传 `--userDataDir`。
- chrome-devtools-mcp `browser.js` `ensureBrowserConnected`（:57-62）：autoConnect 读 `DevToolsActivePort` 的前提是 `options.userDataDir` 非空；**为空则走 else 分支** `connectOptions.channel='chrome'`（puppeteer 按 channel **启动新实例**），根本不读用户日常 Chrome 的 `DevToolsActivePort`。
- 实测：不传 userDataDir 报「Could not find DevToolsActivePort」；手动补 `--userDataDir=~/Library/Application Support/Google/Chrome` 后变成读文件拿 9222 去连（报 ECONNREFUSED——老板 Chrome 调试 server 此刻没在听，用户侧状态，非我们 bug）。**证明补 userDataDir 后走的是「读文件」正确路径。**

### Bug 2：attach 计数不对（台账/内存虚高）

**代码实证**：
- `attach-mode-impl.ts` `execute()` 失活路径（`isAttachConnectionLost`，Chrome 被关）只 `handle.state='dead'` + return `attach_lost`（:88-94），**不即时 `env.ledger.delete(handle.key)` 也不从内存 instances Map 移除**。
- 兜底 `manager.execute`（instance-manager.ts:243-245）虽在 `state==='dead'` 时调 `closeInstance`（删表 + impl.close），但该兜底**只在「同 key 再次 execute」时才触发**——失活后用户不再操作/不主动 close → 无人触发 → 台账计数残留虚高、`size`/`listAll` 不准。

---

## 变更清单（method 级）

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---|---|---|---|---|---|---|---|
| **Bug1** |
| F1 | browser/attach-debug-state | `app/server/src/tools/browser/attach-debug-state.ts` | `defaultChromeUserDataDirCandidates` | **新增** | 新导出函数 `(home: string, platform: string = process.platform): string[]`，返回各平台默认 Chrome **user data dir** 候选路径（去掉 `devToolsActivePortCandidates` 各路径末尾的 `/DevToolsActivePort`）。实现：内部直接复用 `devToolsActivePortCandidates(home, platform).map(p => dirname(p))`，单一数据源不双写路径。darwin→`~/Library/Application Support/Google/Chrome`；linux→`~/.config/google-chrome`、`~/.config/chromium`；win32→`%LOCALAPPDATA%/Google/Chrome/User Data`。 | MUST 复用 `devToolsActivePortCandidates`（dirname 派生），MUST NOT 手写平台路径字符串；返回数组顺序 = 候选优先级 | attach-debug-state.ts:44 | +8 |
| F2 | browser/attach-instance | `app/server/src/tools/browser/attach-instance.ts` | `connectAttachSession` | 修改 | `driver.connect({})` → 注入默认 userDataDir：`driver.connect({ userDataDir: resolveDefaultChromeUserDataDir() })`。新增模块内私有 helper `resolveDefaultChromeUserDataDir(): string \| undefined`：遍历 `defaultChromeUserDataDirCandidates(homedir())`，返回**首个 existsSync 存在**的 dir；都不存在 → `undefined`（不传 userDataDir，走旧 else 分支，由 driver 错误引导兜底）。注入后 session 缓存 key 自动含 userDataDir（`cacheKey` 已是 `[profileName, userDataDir]` 二元组），attach 多次 connect 命中同一缓存，语义一致。 | MUST 仅 attach 路径注入（connectAttachSession），MUST NOT 改 `buildChromeMcpArgs`/`driver.connect` 通用语义（避免污染 headless/managed-profile 的非 userDataDir 场景）；dir 不存在时 MUST 传 undefined（不发明目录） | chrome-mcp-driver.ts:65-68,104-107,202-206 | +12 |
| F3 | browser/attach-instance | `app/server/src/tools/browser/attach-instance.ts` | （文件头 import） | 修改 | 新增 import：`defaultChromeUserDataDirCandidates`（from `./attach-debug-state`）+ `homedir`（from `node:os`）+ `existsSync`（from `node:fs`）。 | 仅 import 追加 | — | +3 |
| **Bug2** |
| F4 | browser/instance-manager | `app/server/src/tools/browser/instance-manager.ts` | `discardInstance` | **新增** | 新公开方法 `discardInstance(key: string): void`（同步）：`this.instances.delete(key)`。专供 impl 在失活等「资源已死、无需走 impl.close」场景下即时摘表，让 `size`/`listAll` 实时准确。不调 `impl.close`（attach 失活时 MCP 连接已断，无需 disconnect）。 | MUST 同步无副作用（仅删内存 Map）；MUST NOT 触发 impl.close/ledger 操作（台账由 impl 自删，见 F5）；幂等（key 不存在 no-op） | instance-manager.ts:312 | +6 |
| F5 | browser/mode-impl | `app/server/src/tools/browser/mode-impl.ts` | `ModeImplEnv.discardInstance` | **新增** | 接口加可选字段 `discardInstance?(key: string): void`（impl 即时摘表回调，由 manager 装配注入，见 F6）。注释标注「v0.0.334 fix：attach 失活即时摘表」。 | 可选字段（worker impl 不强制实现/注入） | mode-impl.ts:55-67 | +3 |
| F6 | browser/instance-manager | `app/server/src/tools/browser/instance-manager.ts` | `constructor`（env 装配） | 修改 | 构造 env 时注入 `discardInstance: (key) => this.discardInstance(key)`（绑定 F4 方法）。对齐现有 env 字段注入风格（`releasePort: (port) => ...`）。 | MUST 箭头绑定保持 this | instance-manager.ts:74-90 | +1 |
| F7 | browser/attach-mode-impl | `app/server/src/tools/browser/attach-mode-impl.ts` | `AttachModeImpl.execute` | 修改 | 失活分支（`isAttachConnectionLost` 命中）在 `handle.state='dead'` 后、return 前，**即时清账**：① `try { env.ledger.delete(handle.key) } catch (e) { console.warn(...best-effort...) }`；② `env.discardInstance?.(handle.key)`（删内存 instance）。语义：attach 失活 = Chrome 已被关、MCP 连接已断，资源实际已死，无需等 close 兜底；ledger.delete 幂等（后续 closeInstance 兜底再删 no-op），discardInstance 幂等（map.delete 不存在 key no-op）。 | MUST best-effort（delete 失败 warn 不阻断 return attach_lost）；MUST NOT 调 `disconnectAttachSession`（连接已断，重复 disconnect 无意义）；保持 return 的 error.kind='attach_lost' 不变 | attach-mode-impl.ts:88-94; instance-ledger.ts:96（delete 幂等） | +8 |

---

## 设计说明（关键裁决）

1. **Bug1 注入点选在 `connectAttachSession` 而非 `buildChromeMcpArgs`/`driver.connect`**：
   - `driver.connect` 同时服务 headless / managed-profile / attach 三模式；前两者本就不传 userDataDir（走临时/持久目录由各自 launch 管），在 driver 通用层默认补 userDataDir 会**误改非 attach 模式行为**。
   - `buildChromeMcpArgs` 是纯 flag 构造函数，不该内置「attach 默认读用户 Chrome profile」这种 attach 专属策略。
   - `connectAttachSession` 是 attach 唯一入口，且 session 缓存 key（`[profileName, userDataDir]`）在 driver 内自动一致——注入后 attach 多次 connect 命中同缓存，无副作用。
   - 满足约束「只读 DevToolsActivePort 连接、不主动 launch 重启用户 Chrome」：补 userDataDir 后 chrome-devtools-mcp 走 `browser.js:57-62` 读文件分支（autoConnect=true），**不 launch**。

2. **Bug1 失败引导**：用户没开 remote debugging → DevToolsActivePort 不存在 → chrome-devtools-mcp 抛 `Could not find DevToolsActivePort` → 包装为含 `chrome://inspect/#remote-debugging` 引导的错误（334 调查结论 #2 已实证），driver `attachFailGuide` 再叠加版本差异化提示。**无需改引导逻辑，补 userDataDir 后自然命中既有引导链**（符合需求②）。

3. **Bug2 为何 impl 自删 + manager 暴露 `discardInstance`，而非依赖现有兜底**：现有 `manager.execute` 的 `closeInstance` 兜底是「**下次同 key execute 才触发**」的惰性清理，失活后用户不再操作即残留。修复要求「**失活当下**」台账/内存即准确（`size`/`listAll` 反映真实存活数）。impl 不持实例表（架构：impl 是无状态策略集），故由 manager 暴露最小同步摘表口 `discardInstance` 经 env 注入，impl 失活分支调用。`impl.close` 里的 `ledger.delete` 与残留检测**保留不动**——`discardInstance` 路径不调 impl.close（attach 失活 MCP 已断，无需 disconnect；残留检测属 close 语义，失活不触发）。

4. **不改 `buildChromeMcpArgs` 签名**：F2 仅改 attach 调用方传入的 opts；`buildChromeMcpArgs` 保持「userDataDir 非空才加 flag」的纯透传语义不变。

---

## UT 要求（MANDATORY）

- 命令：仓库根执行 `bun --bun x vitest run`（**不是** `bun test`）。
- 新增/更新用例（`app/server/src/tools/browser/__tests__/`）：
  - **Bug1**：`defaultChromeUserDataDirCandidates` 三平台路径正确（darwin/linux/win32，对齐 `devToolsActivePortCandidates` dirname）；`connectAttachSession` 注入 userDataDir（mock driver.connect 断言收到 `{ userDataDir: <首个存在的候选 dir> }`；候选 dir 都不存在时断言传 `{ userDataDir: undefined }`）。
  - **Bug2**：`AttachModeImpl.execute` 失活（mock dispatchAction 返回 `isAttachConnectionLost` 命中文本）后——`env.ledger.delete` 被调（handle.key）+ `env.discardInstance` 被调（handle.key）+ return error.kind='attach_lost'；`discardInstance` 幂等（重复调不抛）。
- 全量零回归。

## 影响面 / 风险

- 仅触 attach 模式路径；headless / managed-profile 不动。
- `ModeImplEnv` 加**可选**字段，worker impl 不受影响。
- `ledger.delete` / `discardInstance` 均幂等，与现有 close 兜底路径兼容（重复删除 no-op）。
