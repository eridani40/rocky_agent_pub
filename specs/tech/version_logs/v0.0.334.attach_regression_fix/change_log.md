# v0.0.334.attach_regression_fix change_log — attach 连不上 + 计数虚高回归修复

> 对应 change_plan：`specs/tech/version_logs/v0.0.334.attach_regression_fix/change_plan.md`（F1-F7，frozen）。
> 上游：leader（Darvin）2026-08-12 12:21 派单（根因 leader 代码实证 + 实测定论）。
> commits：`2545b939a`（修复主体）。
> 本文为文档同步补记（原版本仅 change_plan 无 change_log，2026-08-13 doc-modifier2 按审计报告 PartB #15-17 补齐）。

## 变更摘要（已合并编码）

### Bug1（P0）：attach 连不上（334 删 cdpUrl 引入的回归）

- 根因链：`buildChromeMcpArgs` 只在 `input.userDataDir` 非空时加 `--userDataDir`；attach 的 `connectAttachSession` 调 `driver.connect({})`（空 opts）→ `userDataDir=undefined` → 不传 flag；chrome-devtools-mcp `ensureBrowserConnected` autoConnect 读 `DevToolsActivePort` 的前提是 userDataDir 非空，为空走 else 分支 `channel='chrome'`（puppeteer 按 channel **启动新实例**，不读用户 Chrome 的 DevToolsActivePort）→ 永远连不上用户日常 Chrome。
- 修复：`connectAttachSession` 注入默认 userDataDir 候选（复用 `devToolsActivePortCandidates` dirname 派生，首个 existsSync 存在者；无候选传 undefined）。

### Bug2（P1）：attach 计数虚高（台账/内存残留）

- 根因链：`AttachModeImpl.execute` 失活路径（`isAttachConnectionLost`）只 `handle.state='dead'` + return `attach_lost`，不即时清账；manager.execute 的 closeInstance 兜底只在「同 key 再次 execute」才触发——失活后用户不再操作 → 台账计数残留虚高、`size`/`listAll` 不准。
- 修复：失活当下 impl 即时清账（`env.ledger.delete` + `env.discardInstance`，均 best-effort 幂等）。

## 实现核对（method 级）

| 计划项 | 实现一致性 |
|---|---|
| F1（defaultChromeUserDataDirCandidates） | ✅ `attach-debug-state.ts` 导出 `(home, platform = process.platform) => string[]`，内部 `devToolsActivePortCandidates(home, platform).map(p => dirname(p))` 单一数据源派生（darwin/linux/win32 三平台），不手写路径字符串 |
| F2（connectAttachSession 注入 userDataDir） | ✅ `attach-instance.ts` `resolveDefaultChromeUserDataDir(deps)` 遍历候选返首个 `existsSync` 存在的 dir；全不存在返 `undefined`；`driver.connect({ userDataDir })` 仅 attach 路径注入，`buildChromeMcpArgs`/`driver.connect` 通用语义未改 |
| F3（import 追加） | ✅ `defaultChromeUserDataDirCandidates` + `homedir`（node:os）+ `existsSync`（node:fs） |
| F4（discardInstance 新公开方法） | ✅ `instance-manager.ts` `discardInstance(key): void` 同步 `this.instances.delete(key)`；不调 impl.close/ledger（台账由 impl 自删）；幂等（key 不存在 no-op） |
| F5（ModeImplEnv.discardInstance 可选字段） | ✅ `mode-impl.ts` 接口加 `discardInstance?(key: string): void`（可选，worker impl 不强制注入） |
| F6（constructor env 装配注入） | ✅ `instance-manager.ts` 构造 env 时 `discardInstance: (key) => this.discardInstance(key)`（箭头绑定 this），对齐既有 env 字段注入风格 |
| F7（execute 失活即时清账） | ✅ `attach-mode-impl.ts` 失活分支 `handle.state='dead'` 后：① `try { env.ledger.delete(handle.key) } catch → warn`（best-effort 不阻断）；② `env.discardInstance?.(handle.key)`；return error.kind='attach_lost' 不变；MUST NOT 调 disconnectAttachSession（连接已断）已守 |
| UT（MANDATORY） | ✅ `attach-instance.test.ts`（候选三平台 + 注入断言含 undefined 分支）+ `attach-mode-impl.test.ts`（失活后 ledger.delete/discardInstance 被调 + attach_lost + 幂等） |

## 关键设计决策（对齐 change_plan §设计说明）

1. **Bug1 注入点选 `connectAttachSession` 而非 `buildChromeMcpArgs`/`driver.connect`**：driver.connect 服务三模式，通用层补默认会误改 headless/managed-profile 行为；connectAttachSession 是 attach 唯一入口且 session 缓存 key（`[profileName, userDataDir]`）自动一致。补 userDataDir 后 chrome-devtools-mcp 走读文件分支（autoConnect），**不 launch** 用户 Chrome。
2. **Bug2 impl 自删 + manager 暴露 `discardInstance`**：impl 是无状态策略集不持实例表，故 manager 暴露最小同步摘表口经 env 注入；`impl.close` 的 ledger.delete 与残留检测保留不动（discardInstance 路径不调 impl.close——MCP 已断无需 disconnect；残留检测属 close 语义，失活不触发）。
3. **`buildChromeMcpArgs` 签名不改**：保持「userDataDir 非空才加 flag」纯透传语义。

## doc 同步记录（2026-08-13 补）

| 文档 | 同步内容 |
|---|---|
| `specs/tech/agent/tools/[P1]browser_instance_manager.md` | §4.2 attach execute 流程序补「失活即时清账（ledger.delete + discardInstance，best-effort 幂等）」+ manager 收尾退化为防御 catch；§7 错误处理表 attach 失活行同步 |
| `specs/tech/agent/tools/[P1]browser_tool.md` | §4.1 target 解析段补「默认 userDataDir 候选注入」（`connectAttachSession` 注入，`devToolsActivePortCandidates` dirname 派生，无候选传 undefined） |
| 本文 | 补 change_log（F1-F7 实现核对 + doc 同步记录） |

> 审计线索：specs/tech/version_logs/ 15 个版本中本版唯一无 change_log（审计报告 PartB #15-17）。
