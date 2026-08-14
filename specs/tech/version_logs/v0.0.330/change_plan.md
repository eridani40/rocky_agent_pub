# v0.0.330 变更计划书 — browser attach 修复 + tool desc 三模式示例

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> req 权威：`reqs/[working]/v0.0.330.browser-attach-fix.md`（leader 已实测确认根因）
> worktree：`worktrees/v0.0.330-browser-attach-fix`（分支 v0.0.330-browser-attach-fix，基于 dev1 1904301e9）
> 纯技术改动，跳 PRD（无用户可感知新交互，是 bug 修复 + 工具描述补全）。

## 0. 方案一句话

去掉 attach 缺省 cdpUrl 强制塞 `http://127.0.0.1:9222`（v0.0.266 回归）：`attach-instance.ts` 缺省原样传 undefined → driver 走 `--autoConnect`（chrome 144+ inspect 远调模式唯一可用，spec `[P1]browser_tool.md §4` 设计如此）。同步补 tool desc 三模式示例（老板强调 LLM 能调对）+ UT 更新。headless/managed-profile 逻辑零动。

## 1. 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 根因 | `attach-instance.ts` L40/59 `cdpUrl ?? DEFAULT_ATTACH_CDP_URL` 把缺省塞成 `http://127.0.0.1:9222` → `buildChromeMcpArgs` 见 browserUrl 走 `--browserUrl` 分支 → chrome 144+ inspect 远调不暴露 `/json/version` → 404 必挂 | attach-instance.ts L21/L40/L59；chrome-mcp-driver.ts L251-259（browserUrl 分支） |
| driver 默认行为已正确 | `buildChromeMcpArgs` 无 browserUrl → `--autoConnect`（v0.0.34.1 HOTFIX 已实现），connect() probe isError 兜住自启副作用 | chrome-mcp-driver.ts L246-259；test L68-73 |
| 修复点 | 只改 attach-instance.ts 两处 `?? DEFAULT_ATTACH_CDP_URL` → 原样传 undefined；driver/dispatch 零动 | attach-instance.ts L40/L59 |
| cacheKey 一致性 | connect/disconnect 同步改（都传 undefined）→ cacheKey 三元组（profileName/userDataDir/cdpUrl=null）一致，cache miss 不泄漏 | chrome-mcp-driver.ts L191-197；attach-mode-impl.ts L38/L44/L75 |
| tool desc 现状 | description L72（一行概括）+ mode L81（"chrome 启动/连接模式"）+ action L97-98（已有"先 launch 再其他 action"）+ cdpUrl L104（已提 fallback + SSRF）——**缺三模式语义与调用示例** | tool.ts L72-105 |
| UT 现状 | test L95-101「cdpUrl http → --browserUrl」用 DEFAULT_ATTACH_CDP_URL 字面量（保留，显式 cdpUrl 路径仍对）；L68-73 已有「无 browserUrl → --autoConnect」；**缺 attach-instance 缺省走 autoConnect 的断言** | chrome-mcp-driver.test.ts L68-73/L95-101 |
| 不做 | headless/managed-profile 逻辑、新 flag/新模式、chrome-devtools-mcp 包 | req「不做」 |

## 2. 设计红线（review 卡这几点）

1. **缺省走 autoConnect**：attach 不传 cdpUrl → driver.connect({cdpUrl: undefined}) → buildChromeMcpArgs 无 browserUrl → `--autoConnect`（spec §4 设计语义）。
2. **显式 cdpUrl 保留**：用户显式传 cdpUrl（--remote-debugging-port 启动）→ 仍走 `--browserUrl`/`--wsEndpoint`（用户自负端点契约），**不允许被默认值污染**。
3. **connect/disconnect 对称**：两处同步改（cacheKey 三元组一致，cache miss no-op 幂等不破坏）。
4. **desc 写透**：三模式语义 + 流程铁律 + 每 mode 调用示例（LLM 可照抄调对）；不改 schema 结构（不新增字段/枚举）。
5. **UT 对齐**：断言「attach 缺省走 autoConnect」+ 显式 cdpUrl 仍走 --browserUrl（既有用例保留）。

## 3. 设计决策（D 编号，method 级契约）

### D1: attach-instance 去默认 cdpUrl — attach-instance.ts（修改）

**文件**：`app/server/src/tools/browser/attach-instance.ts`（修改，~80 行 → ~75 行）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `import { DEFAULT_ATTACH_CDP_URL }` | 删除 | 删 L21 的 DEFAULT_ATTACH_CDP_URL import（不再引用） | MUST 同步删 import（无残留引用） | attach-instance.ts L21 | -1 |
| `connectAttachSession(driver, cdpUrl?)` | 修改 | L40 `driver.connect({ cdpUrl: cdpUrl ?? DEFAULT_ATTACH_CDP_URL })` → `driver.connect({ cdpUrl })`（undefined 原样传，driver 走 --autoConnect） | MUST 缺省 undefined 不塞默认值；MUST 显式 cdpUrl 原样透传 | req 修复 1；chrome-mcp-driver L251-259 | ~2 |
| `disconnectAttachSession(driver, cdpUrl?)` | 修改 | L59 同改：`driver.disconnect({ cdpUrl })`（undefined 原样传） | MUST 与 connect 对称（cacheKey 三元组一致，cache miss no-op） | req 修复 1；chrome-mcp-driver L191-197 | ~2 |
| 文件头注释 | 修改 | attach 语义段补「缺省 cdpUrl → driver 走 --autoConnect（spec §4，chrome 144+ inspect 远调唯一可用）」 | MUST 注释与行为一致（可维护性） | spec [P1]browser_tool.md §4 | +3 |

### D2: tool desc 三模式写透 — tool.ts（修改）

**文件**：`app/server/src/tools/browser/tool.ts`（修改，~200 行 → ~240 行）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `definition.description` | 修改 | L72 一行概括 → 补全三模式语义：headless=无头临时浏览器（一次性不留状态）；managed-profile=有头持久 profile（可复用登录态）；attach=连接用户已打开的 Chrome（autoConnect，close=断连接不杀浏览器） | MUST 顶层 description 覆盖三模式核心语义 | req 修复 2；browser_tool.md §4 | ~10 |
| `properties.mode.description` | 修改 | L81「chrome 启动/连接模式」→ 逐 mode 写透语义（headless 无头一次性 / managed-profile 持久复用 / attach 连接已开 Chrome） | MUST 三 mode 语义清晰（LLM 选对模式） | req 修复 2 | ~8 |
| `properties.action.description` | 修改 | L97-98 已有流程铁律 → 补「**必须先 launch 初始化再调其他 action**」强调 + attach close=断连接不杀浏览器 | MUST 流程铁律显式（先 launch 再操作） | req 修复 2 | ~4 |
| `properties.cdpUrl.description` | 修改 | L104 → 写清「attach 模式可选；**缺省自动连接用户已打开的 Chrome（autoConnect），仅当 Chrome 以 --remote-debugging-port 显式启动时才传此端点**；loopback 豁免 SSRF，非 loopback fail-closed」 | MUST 明确「仅显式启动才传」（LLM 不乱传 9222） | req 修复 2 | ~5 |
| 顶层 description 追加示例 | 新增 | 每 mode 一个调用示例（launch → navigate → snapshot/click/type → close 全流程）：headless / managed-profile / attach 各一段 JSON 示例 | MUST 示例可照抄（LLM 调对）；MUST 示例字段与 schema 一致（mode/action/url 等） | req 修复 2 | +30 |

> **示例格式**：description 内嵌 JSON 示例（如 `Example (headless): {"mode":"headless","action":"launch"} → {"mode":"headless","action":"navigate","url":"https://..."} → ...`），不新增 schema 字段。coder 落 change_log 时贴最终文本。

### D3: UT 更新 — chrome-mcp-driver.test.ts + attach-instance 测试（修改）

**文件**：`app/server/src/tools/browser/__tests__/chrome-mcp-driver.test.ts`（修改）+ 新增 attach-instance 断言

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| L95-101 用例「cdpUrl http → --browserUrl」 | 保留 | 显式 cdpUrl 仍走 --browserUrl（用户显式传端点契约不变） | MUST 保留（显式路径不回归） | 现状测试 | 0 |
| 新增用例「attach-instance 缺省 → connect({cdpUrl: undefined}) → --autoConnect」 | 新增 | mock driver 断言 connectAttachSession(driver, undefined) 调用 connect 时 cdpUrl 为 undefined；buildChromeMcpArgs 无 browserUrl → 含 --autoConnect 不含 --browserUrl | MUST 断言缺省走 autoConnect（修复验收点 1） | req 验收 1 | +12 |
| 新增用例「显式 cdpUrl → 原样透传」 | 新增 | connectAttachSession(driver, 'http://127.0.0.1:9333') → connect({cdpUrl:'http://...9333'})；buildChromeMcpArgs → --browserUrl | MUST 断言显式端点不被默认值污染（修复验收点 2） | req 验收 2 | +10 |
| attach-instance 相关既有测试 | 同步 | grep 现有引用 DEFAULT_ATTACH_CDP_URL 的用例全查一遍，只保留「显式 cdpUrl」语义；缺省断言改走 autoConnect | MUST 全测试文件无残留「缺省塞 9222」断言 | req 修复 3 | 若干 |

## 4. 回归保护（review 必查）

| 项 | 保护 |
|----|------|
| headless/managed-profile | 零改动（req 不做）；工具 desc 变化不改变 action 路由 |
| 显式 cdpUrl attach | 仍走 --browserUrl/--wsEndpoint（L95-101 用例保留） |
| cacheKey 一致性 | connect/disconnect 同步传 undefined → 三元组一致，cache miss no-op 幂等 |
| SSRF 门禁 | tool.ts L122-135 不动（显式 cdpUrl 仍过 SSRF 校验；缺省 undefined 跳过） |
| connectorManager 路径 | v0.0.266 后 attach 归 InstanceManager（driver.connect 主路径），本改动不触碰 ConnectorManager |

## 5. 验证（test-plan）

- **UT**（MANDATORY）：`chrome-mcp-driver.test.ts` 全绿（新增缺省走 autoConnect + 显式透传断言；既有用例保留）；`attach-instance` 相关测试同步；`bun run test` 全绿（browser 相关）。
- **AT**：无 API 契约变化 → 不新增。
- **E2E**：browser 三模式真实调用（ET，e2e-test-executor）：headless / managed-profile / attach 各 `launch → navigate → close` 全流程；**attach 需真 Chrome 远调模式**（用户已开 Chrome 或 `--remote-debugging-port` 显式启动）；断言 attach 缺省不传 cdpUrl 能连上（修复验收点 1）+ 显式 cdpUrl 仍走 --browserUrl（验收点 2）。

---

# Delta 2（追加）：browser instance key 收敛 + desc 重写 + worker 构建机制

> 追加背景：老板确认 browser 工具核心语义（也是通用参数设计原则）+ ET 实证 blocking。leader 派单追加，含 D-A~D-F + 持久化/attach 兼容评估 + UT/E2E 更新。

## 6. 方案一句话

instanceKey 三模式统一 `sessionId:mode`（profileName 不进 key，修复 ET blocking：launch 带 profileName 后 navigate/close 不带 → key 不匹配 → no_browser_instance）+ launch 幂等复用语义明确（同 session 同 mode 重复 launch = 复用，不换 profile）+ close 无实例明确报错（不静默 no-op）+ tool desc 重写（launch 一次性传全部初始化参数，之后只需 mode+action）+ worker 构建机制（dev/ET 启动补 build:worker + 产物 gitignore）。

## 7. 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| ET blocking 根因 | `instanceKey` L44-48：managed-profile 且带 profileName → `sid:managed-profile:p1`；后续 navigate/close 不带 profileName → key=`sid:managed-profile` → 查表 miss → no_browser_instance | instance-manager.ts L44-48；ET 实证 |
| handle 已存全部资源 | WorkerHandle 存 profileName/userDataDir/cdpPort/workerPid/chromePid；execute 用 `wh.worker.send(action,params)`、close 用 handle 字段——**均不依赖 opts.profileName** → D-A 后 execute/close 天然兼容 | worker-mode-impl.ts L39-56/L123-190 |
| attach cdpUrl 不进 key | attach key 现状已是 `sid:attach`（cdpUrl 不进 key）；AttachHandle 已存 cdpUrl，close 用 `ah.cdpUrl`（L75）→ 老板语义「attach 后续用 autoConnect 或已存 handle」已满足，D-A 后不变 | attach-mode-impl.ts L27-31/L75 |
| launch 复用语义 | launch L199-200 ready 复用已实现，但返回文本 `reuse ${modeLabel(opts)}` 用 opts.profileName（可能缺/不同）→ 需改用 handle 存的首次 profileName | instance-manager.ts L197-210 |
| close 现状 | close L235 无实例 → `{ok:true, text:'no instance'}` 静默 no-op（老板语义③违反）；有实例重复 close 走 impl.close 幂等（保留） | instance-manager.ts L232-238；测试 L380-384/L913-919 |
| 持久化兼容 | PersistedInstanceRecord.key 随 D-A 变新格式；旧记录（`sid:managed-profile:p1`）由开机自检 cleanupOrphans() 按 rec.mode 分发 cleanupOrphan → kill + unpersistInstance(rec.key)（用 rec.key 匹配自己，自洽）→ 自动收敛，无需迁移 | instance-manager.ts L98-111；worker-mode-impl.ts L190-199；instance-record.ts |
| reconcile/orphan-scan | reconcileOrphans 记录同步用 `rec.userDataDir===proc.userDataDir → unpersist(rec.key)`（自洽）；orphan-scan 不读 key（只读 pid/userDataDir）→ 无影响 | instance-manager.ts L158-161；orphan-scan.ts |
| worker 构建机制 | browser-worker.cjs git 最后 commit = v0.0.226（旧 bundle，无 loop/chromePid 协议）；工作区 M（有 rebuild 未 commit）→ 全新 checkout/dev/ET 跑旧 bundle → headless/managed 常驻必挂。run-dev.sh / tests/api/env_start.sh 均无 build:worker；package.json 已有 build:worker + prebuild（packaged 路径覆盖）；resolveWorkerPath 优先 worker-entry.js（tsc 产物）否则 cjs | git log browser-worker.cjs；package.json scripts；node-worker-driver.ts L281-290 |

## 8. method 级变更清单（Delta 2）

### 核心逻辑

| # | 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|---|
| D-A | browser | `instance-manager.ts` | `instanceKey()` L43-48 | 修改 | 三模式统一 `${sessionId}:${mode}`：删 managed-profile 分支，直接 `return \`${sessionId}:${opts.mode}\`` | MUST：key 格式变化只影响 managed-profile（headless/attach 原本就是 sid:mode）；MUST NOT：sessionId owner 隔离语义改变 | 老板语义①；ET 实证 | 4→1 |
| D-B | browser | `instance-manager.ts` | `launch()` L197-210 + `modeLabel()` L51-53 | 修改 | ①ready 复用返回文本改用 handle 存的首次 profileName：`reuse ${opts.mode}${handle.profileName ? ' (profile: '+handle.profileName+')' : ''}`（不读 opts.profileName——可能缺/不同）②`modeLabel` 改为只用 mode（error 提示不再带 profile 名，避免误导：实例是 p1 但 opts 传 p2）③launch 前清理非 ready 旧实例逻辑保留 | MUST：同 session 同 mode 重复 launch = 复用已有实例，不换 profile（即使 opts.profileName 不同）；MUST：首次 launch 的 profileName 已存 handle（worker-mode-impl L69/L83 现状满足，零改） | 老板语义② | ~6 |
| D-C | browser | `instance-manager.ts` | `close()` L232-238 | 修改 | 无 instance → `{ok:false, error:{kind:'no_browser_instance', message:\`当前会话没有 ${opts.mode} 浏览器实例，请先调用 browser(action="launch")\`}}`（不再静默 no-op） | MUST：有实例重复 close 仍幂等（impl.close 兜底，不变）；MUST NOT：releaseSession/releaseAll 内部路径受影响（走 closeInstance 不经 close()） | 老板语义③ | 3 |
| D-D | browser | `tool.ts` | description L72-76 + mode/action/profileName/cdpUrl 字段 desc | 修改 | desc 重写：①顶层加「参数传递铁律」——launch 一次性传全部初始化参数（mode + profileName/cdpUrl），创建后 navigate/snapshot/click/type/close 只需 mode+action，不再重传初始化参数；未 launch 即操作/关闭 → 明确报错提示先 launch ②profileName desc 改 `'mode=② 初始化参数（仅 launch 时传；之后操作/关闭无需再传）'` ③action desc 补 close 无实例报错语义 ④示例更新：managed-profile 示例 launch 带 profileName、后续 action 不带（headless/attach 示例保持） | MUST：不新增/删除 schema 字段（仅 desc 文本）；MUST：三模式示例保持完整（launch→navigate→…→close） | 老板语义①②③ | ~15 |
| D-E | dev/ET | `scripts/run-dev.sh` + `tests/api/env_start.sh` | 启动前构建 worker | 新增 | ①run-dev.sh 在「0a. gen-version」后加 `bun run build:worker`（每次 dev 启动前重建 browser-worker.cjs，保证 headless/managed 常驻协议最新）②tests/api/env_start.sh 同加 build:worker（ET/AT 前重建） | MUST：build:worker 幂等（bun build 覆盖写，~1s）；MUST NOT：改动 prebuild（packaged 路径已覆盖） | leader ET 发现；node-worker-driver L281-290 | ~2 |
| D-F | 产物治理 | `.gitignore` + git | browser-worker.cjs 出库 | 新增 | `.gitignore` 加 `app/server/src/tools/browser/browser-worker.cjs` + `git rm --cached app/server/src/tools/browser/browser-worker.cjs`（保留工作区文件）——当前库里是 v0.0.226 旧 bundle，误导且 dev/ET 常驻必挂根因之一；产物由 D-E 启动构建生成 | MUST：git rm --cached 不删磁盘文件；MUST：确认 build:worker 后 cjs 仍存在（resolveWorkerPath 兜底路径有效） | git log 76640e309 | 2 |

### UT 更新（Delta 2）

| # | 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|---|
| U1 | browser test | `instance-manager.test.ts` | launch managed-profile 断言 | 修改 | L255 附近：断言 handle.key === 's1:managed-profile'（不再含 :p1）；新增 `instanceKey('s1', {mode:'managed-profile', profileName:'p1'}) === 's1:managed-profile'` 纯函数断言 | MUST：同步 D-A | D-A | ~5 |
| U2 | browser test | 同上 | 「launch(p1) 后 execute 不带 profileName」 | 新增 | ET blocking 复现断言：launch('s1',{mode:'managed-profile',profileName:'p1'}) → execute('s1',{mode:'managed-profile'},'navigate',...) → ok（key 匹配） | MUST：修复验收点 | D-A | ~8 |
| U3 | browser test | 同上 | 「launch(p1) 后 launch(p2) → reuse 不换 profile」 | 新增 | 同 session 同 mode 重复 launch 不同 profileName → 返回 reuse（spawn 不再发生）；文本含 'profile: p1' | MUST：老板语义② | D-B | ~8 |
| U4 | browser test | 同上 | close 无实例断言 | 修改 | L380-384：`close('s1',{mode:'headless'})` → `ok:false` + error.kind==='no_browser_instance' + message 含 '请先调用 browser(action="launch")' | MUST：同步 D-C | D-C | ~5 |
| U5 | browser test | 同上 | attach close 幂等断言 | 修改 | L913-919：重复 close 无实例 → 改断言报错（不再 'no instance' 文本） | MUST：同步 D-C | D-C | ~5 |
| U6 | browser test | 同上 | 持久化记录 key 断言 | 新增 | persistInstance 后 readRecords() 记录 key 为新格式 `sid:mode`（managed-profile 无 :p1 后缀） | MUST：同步 D-A | D-A | ~4 |

## 9. 兼容性评估（老板点名必答）

### 9.1 持久化记录（PersistedInstanceRecord.key）兼容

- **key 格式变化**：`sid:managed-profile:p1` → `sid:managed-profile`（仅 managed-profile 受影响；headless/attach 不变）
- **旧记录收敛**：开机自检 `cleanupOrphans()`（L98-111）按 rec.mode 分发 `cleanupOrphan` → kill 残留 chrome + `unpersistInstance(rec.key)`（用 rec.key 匹配自己）→ 旧格式记录自动清理，**无需数据迁移**
- **reconcile 同步**：`rec.userDataDir === proc.userDataDir → unpersist(rec.key)`（L158-161）用 rec.key 自洽
- **新记录写入**：persistInstance filter `r.key !== rec.key` → 同 session 同 mode 新记录覆盖旧格式记录（如果旧记录还在）
- **结论**：无兼容问题，开机自检自然收敛。语义变化 = 同 session 同 mode 只能 1 实例（正是老板语义①）

### 9.2 attach 模式 cdpUrl 是否进 key

- **结论：不进 key**（现状已正确，D-A 后不变）
- attach key 已是 `sid:attach`；AttachHandle 已存 cdpUrl（attach-mode-impl L27-31），close 用 `ah.cdpUrl`（L75）→ 后续调用无需重传
- 老板语义「attach 后续也用 autoConnect 或已存 handle」已由 handle 承载，零改

### 9.3 语义边界（一个 session 每 mode 1 实例的推论）

- launch(p1) → launch(p2) = 复用 p1（不换 profile）——**这不是 bug，是老板语义**（创建后使用/关闭只需 mode）
- 想换 profile：先 close 再 launch（D-C 后 close 无实例会报错提示先 launch，有实例正常关闭）

## 10. 验证（Delta 2 test-plan）

- **UT**（MANDATORY）：U1-U6 全绿（instance-manager.test.ts）；`bun run test` 全绿（browser 相关）
- **E2E**（ET，修复验收点 = 原 blocking 场景）：managed-profile `launch(profileName=et330-p1)` → `navigate`（不带 profileName）→ `close`（不带 profileName）全程成功；headless launch→navigate→close；attach launch(autoConnect)→navigate→close；回归 owner 隔离（s2 同 mode → no_browser_instance）
- **机制验证**：dev 启动（run-dev.sh）后确认 browser-worker.cjs 为最新构建（含 loop/chromePid 协议）；ET env_start.sh 启动后同验证；`git status` 确认 cjs 不再被跟踪

---

# Delta 3（追加）：attach close 对称关闭 Chrome 调试态（老板铁律：资源成对回收）

> 追加背景：ET 复验 blocking —— attach launch(autoConnect) → navigate → close 后，老板 Chrome 仍残留调试态（9222 监听 lsof 证据 + 「Chrome 正受到自动测试软件的控制」提示条 + chrome://inspect Allow remote debugging 仍勾选）。老板拍板：「attach 必须在创建的时候打开调试，close 的时候要关闭，残留了就是有问题」+ 补充铁律「资源打开了就必须回收！！！而且都是成对的」。本 Delta 覆盖：attach 根因修复 + 三模式对称性验证 + 异常路径 + 老板残留清理。

## 11. 方案一句话

attach close 由「只断 MCP 连接」升级为「**断连接 + 检测调试态残留 + 明确提示引导**」：技术实证 chrome-devtools-mcp / CDP 均**无编程关闭用户 Chrome 调试态的 API**（Chrome 安全设计，远程调试授权是用户级设置），因此能对称回收的是**我们打开的资源**（MCP 代理进程/连接/session 缓存），用户 Chrome 的调试态（9222/提示条/Allow 勾选）**只能检测 + 提示 + 引导用户手动恢复**（chrome://inspect 取消勾选）。同时验证 headless/managed-profile 与异常路径的成对回收现状，并提供老板当前残留的一次性清理指引。

## 12. 能力边界实证（本 Delta 核心裁决依据，已读依赖源码）

| 事实 | 实证 | 结论 |
|------|------|------|
| chrome-devtools-mcp `closeBrowser()` | browser.js L224-240：`browserMode==='launched'` → `b.close()`（杀 Chrome）；`'connected'` → `b.disconnect()`（只断开，不恢复调试态） | autoConnect/显式 cdpUrl 都是 connected → **只断开，调试态原样残留** |
| MCP 工具集 | tools/ 目录：pages/script/snapshot/emulation/network/console/input/memory/performance/screenshot/screencast/extensions/lighthouse/webmcp/thirdPartyDeveloper/slim —— **无 browser-management / 调试态管理工具** | **无关闭/管理 remote-debugging 态的 MCP tool** |
| CDP 协议 | Browser domain：`Browser.close` 杀整个浏览器；**无「关闭调试端口监听」命令**（调试端口由 Chrome 启动参数/用户授权决定，运行时不可变） | **CDP 无关闭调试命令**；`Browser.close` 违反 attach「不杀用户浏览器」语义 |
| autoConnect 语义 | browser.js ensureBrowserConnected L30-120：`--autoConnect` 只连接**已开启**远程调试的 Chrome（userDataDir → 读 `DevToolsActivePort`；channel 分支 → puppeteer.connect channel）；cli-options.js 描述 "Requires the remote debugging server to be started in the Chrome instance via chrome://inspect/#remote-debugging" | autoConnect **不开启**调试态——调试态是用户在 chrome://inspect 授权后 Chrome 侧的状态（9222 监听 + DevToolsActivePort + 提示条） |
| Chrome 144+ 调试态 | 用户勾选 Allow remote debugging → Chrome 监听 9222 + 写 DevToolsActivePort + 显示提示条；状态持久在 Chrome 用户数据目录 Preferences | **无运行时 API 关闭**；只能 UI toggle（chrome://inspect 取消勾选 → Chrome 重启回非调试模式）或重启 Chrome |

**总裁决**：对**用户已打开的 Chrome**（autoConnect / 显式 cdpUrl），关闭其调试态**在编程层面不可行**（无 API + 杀进程不可接受）。「我们打开的我们关」成立；「用户 Chrome 的调试态」只能检测 + 提示 + 引导。

## 13. 边界裁决（谁开的调试态，谁负责关）

| 路径 | 调试态归属 | close 语义 | 边界 |
|------|-----------|-----------|------|
| **autoConnect（缺省）** | 用户在 chrome://inspect 授权开启（launch 只连接不开启） | 断 MCP + **检测残留 + 返回明确提示**（引导 chrome://inspect 取消勾选 / 重启 Chrome） | 我们开 = MCP 进程/连接/session 缓存（全回收）；用户开 = Chrome 调试态（检测+提示，不杀不重启） |
| **显式 cdpUrl** | 用户 `--remote-debugging-port` 显式启动 | 断 MCP + **不关调试态**（用户自己开的，我们无权关） | desc 写透「显式 cdpUrl = 连接用户自开调试 Chrome，close 只断连接，调试态由用户管理」 |
| **headless** | 我们 spawn（worker 路径） | kill workerPid + chromePid + **删 userDataDir** + releasePort + unpersist（现状已对称 ✓） | 我们开我们关 —— **已满足老板铁律**，仅需 UT 断言锁定 |
| **managed-profile** | 我们 spawn（worker 路径） | kill workerPid + chromePid + releasePort + unpersist；**不删 userDataDir**（持久 profile 设计，目录是用户资产非临时资源） | 我们开我们关（进程/端口/记录），profile 目录持久是设计语义 ✓ |
| **异常路径** | releaseSession / releaseAll / idle close / 崩溃回收 | 全部走 `closeInstance` → `impl.close`（manager L250/269/286 + closeInstance L294）→ 与正常 close 同一对称路径 ✓ | 验证 + UT 断言，无需新逻辑 |

## 14. method 级变更清单（Delta 3）

### 核心逻辑

| # | 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|---|
| D3-A | browser | `mode-impl.ts` | `ModeImpl.close()` 返回类型 | 修改 | `Promise<void>` → `Promise<string \| void>`（impl 可返回 close 提示文本；manager closeInstance 透传到 `BrowserExecuteResult.text`） | MUST：worker/attach 两 impl 签名同步；MUST：无提示返回 undefined → manager 保持现文本 'closed' | attach close 残留提示需要出口 | ~2 |
| D3-B | browser | `attach-mode-impl.ts` | `close()` L72-77 | 修改 | ①断 MCP 后调 `detectChromeDebugResidual()`（见 D3-C）：检测 close 前 Chrome 调试态是否仍在（TCP 探测 cdpUrl/autoConnect 端口 + DevToolsActivePort 文件存在）②残留 → 返回提示文本：`attach 已断开；检测到 Chrome 调试态残留（9222 监听/提示条），请到 chrome://inspect/#remote-debugging 取消 Allow remote debugging（Chrome 将重启恢复非调试模式），或重启 Chrome`③无残留 → 返回 undefined（manager 输出 'closed'） | MUST：检测失败（探测异常）不阻断 close（降级为无提示）；MUST：显式 cdpUrl 路径不检测/不提示（用户自开，边界 D 裁决） | Delta 3 核心；BrowserSession.close 语义注释（types.ts L153-158） | ~15 |
| D3-C | browser | 新增 `attach-debug-state.ts` | `detectChromeDebugResidual(env, ah): Promise<{ residual: boolean; detail: string }>` | 新增 | ①取检测端口：`ah.cdpUrl` 显式 → 不检测直接返回 `{residual:false}`（用户自开，边界）；autoConnect（cdpUrl 缺省）→ 读 `env.dataDir` 下或用户 Chrome userDataDir 的 `DevToolsActivePort`（拿端口）②TCP connect 探测端口可连 → residual=true ③读 DevToolsActivePort 文件存在 → 附 detail | MUST：只读检测（不 kill/不写文件/不重启 Chrome）；MUST：端口探测失败视为无残留（不误报）；MUST NOT：探测用户 Chrome 之外的进程 | cdp-port.ts netPortBusy 模式（TCP 探测）；DevToolsActivePort 机制（browser.js L62） | ~40（新文件 ≤300 行） |
| D3-D | browser | `instance-manager.ts` | `closeInstance()` L294 + `close()` L232 | 修改 | closeInstance 收集 `impl.close` 返回值：有 → `text` 用之；无 → 现 'closed'；close() 同透传 | MUST：releaseSession/releaseAll 路径同样透传（异常路径提示不丢失）；MUST：返回结构不变（仍 `{ok:true, text}`） | D3-A 接口变更 | ~6 |
| D3-E | browser | `tool.ts` | description attach close 语义 + cdpUrl 边界 | 修改 | ①顶层 desc 补「attach close = 断连接 + 检测 Chrome 调试态残留并提示；**不杀用户浏览器**；用户 Chrome 调试态（9222/提示条）由 chrome://inspect 授权，需用户取消勾选或重启 Chrome 恢复」②cdpUrl desc 补「显式 cdpUrl = 连接用户自开调试 Chrome（--remote-debugging-port），close 只断连接，调试态由用户管理」 | MUST：desc 与 D3-B 行为一致；MUST NOT：新增/删除 schema 字段 | 老板「desc 写透 LLM 调对」 | ~8 |
| D3-F | 脚本 | 新增 `scripts/cleanup-chrome-debug.sh` | 老板残留一次性清理 | 新增 | ①`lsof -iTCP:9222` 检测监听进程（仅报告 Chrome）②检测 `DevToolsActivePort` 文件位置（~/.config/.../DevToolsActivePort）③输出清理指引：chrome://inspect 取消 Allow remote debugging（Chrome 重启回非调试模式，9222 自动消失）/ 或重启 Chrome；**不自动 kill 用户 Chrome** | MUST：只读检测 + 指引，不 kill/不写文件；MUST：输出可照做 | 老板当前残留清理 | ~40 |

### UT 更新（Delta 3）

| # | 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|---|
| U7 | browser test | `attach-mode-impl.test.ts` | close 残留检测断言 | 新增 | mock `detectChromeDebugResidual` 返回 residual=true → close 返回文本含「调试态残留」+ 引导词；residual=false → undefined（manager 出 'closed'） | MUST：两分支断言；MUST：显式 cdpUrl → 不调 detect（边界） | D3-B/D3-C | ~14 |
| U8 | browser test | `instance-manager.test.ts` | close 透传 impl 文本 | 新增 | mock impl.close 返回 '残留提示' → close() 结果 text 含该提示；releaseSession 路径同断言 | MUST：正常 close + releaseSession 两路径 | D3-D | ~8 |
| U9 | browser test | `worker-mode-impl.test.ts` | headless/managed close 对称断言（锁定现状） | 新增 | headless close：kill workerPid+chromePid + 删 userDataDir + releasePort + unpersist 全调用断言；managed-profile：不删 userDataDir（持久语义）+ 其余回收断言；异常路径（impl.close 抛错）→ manager closeInstance 仍置 dead + releasePort 兜底 | MUST：老板铁律 2/3/4 锁定；MUST：断言现有行为不回归 | worker-mode-impl.ts L155-205；instance-manager L294 | ~20 |

## 15. 老板残留清理方案（当前 Chrome 9222/提示条）

- **不自动 kill 老板 Chrome**（丢标签页/会话不可接受，违反 attach 语义红线）
- 一次性清理（D3-F 脚本指引，或老板手动）：
  1. 打开 `chrome://inspect/#remote-debugging` → 取消勾选 **Allow remote debugging** → Chrome 自动重启回非调试模式（9222 监听 + 提示条自动消失）
  2. 若取消勾选不可用（旧版 Chrome）：完全退出 Chrome 后重启（带用户确认，不丢数据）
  3. 验证：`lsof -iTCP:9222` 无输出 + 无「自动测试软件」提示条
- 修复落地后（D3-B 检测+提示），未来 attach close 会明确告知用户如何恢复，不再静默残留

## 16. 验证（Delta 3 test-plan）

- **UT**（MANDATORY）：U7-U9 全绿（attach close 残留检测 + manager 透传 + worker 对称锁定）；既有 U1-U6 + chrome-mcp-driver 测试全绿；`bun run test` 全绿
- **E2E**（ET，e2e-test-executor2）：
  - attach autoConnect：launch → navigate → close → 断言 close 返回含调试态检测结果；MCP 进程无残留（ps 无 chrome-devtools-mcp 代理）+ session 缓存清空
  - attach 显式 cdpUrl：launch → close → 断言返回 'closed'（不检测/不提示，用户自开边界）
  - headless / managed-profile：launch → navigate → close → `lsof` 无 CDP 端口监听 + 无孤儿 chrome 进程 + headless 无 userDataDir 残留（managed-profile 目录保留为设计语义）+ 持久记录清除
  - 异常路径：session 释放（releaseSession）后同断言无残留
  - **调试态残留（9222/提示条）验收说明**：能力边界下（§12 实证），ET 验收「close 后 Chrome 调试态自动消失」**不可达**（无 API）；改为验收「close 返回明确提示 + 引导可执行」；老板若坚持自动关闭，需另行裁决（见汇报：选项 a 改 attach 语义为自启调试实例 / 选项 b 接受引导降级）
