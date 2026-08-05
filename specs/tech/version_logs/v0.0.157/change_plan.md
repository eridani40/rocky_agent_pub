# v0.0.157 变更计划书 — computer/browser 截图本地化（不 inline 进对话上下文）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## §0 设计决策（architect 冻结）

### 根因核实
1. **computer 截图**（prod M3 400 真因）：`image-block.ts:wrapScreenshot()` 把 `port.screenshot()` 的裸 base64 包成 spec 形 `ImageBlock{type:'image', source:{kind:'base64', data}, mediaType}` → 调用方塞进 `tool_result.content[]` → 进入对话 transcript → 纯文本模型 provider 400「Model only support text input」。2 个调用方：`actions/screenshot.ts:43`、`actions/get-app-state.ts:44`。
2. **browser 截图**（同因不同症）：`tool-dispatch.ts:72-76` 把 `session.screenshot()` 的 `{mime, data:Buffer}` 序列化成 `JSON.stringify({mime, data: data.toString('base64')})` 塞进 **textResult 的 TextBlock**（**不是** ImageBlock）。M3 不报错（text 模型接受 text），但：① base64 塞 text 同样进入 transcript（token 暴增、对 LLM 无用）；② 同属「截图 inline 进上下文」根因。必须一并改。

### 设计结论（1–6）

**Q1 browser 序列化点**：`tool-dispatch.ts:72 case 'screenshot'`（attach 模式 + 兜底 connect 路径都走它）。headless/managed-profile 主路径走 **`driver.executeOnce`（Node worker 子进程）**，worker 内部序列化为 `JSON.stringify({mime, data:base64})` 作 `r.text` 返 → `tool.ts:194-196` 包成 `textResult(r.text)`。**两条出口都要改**。

**Q2 全量 inline image 出口**（grep 确认无遗漏）：
| 出口 | 文件 | 当前形态 |
|------|------|---------|
| computer `screenshot` action | `tools/computer-use/actions/screenshot.ts:43` | ImageBlock（M3 400 真因） |
| computer `get_app_state` action | `tools/computer-use/actions/get-app-state.ts:44` | ImageBlock + TextBlock(AX 树) |
| browser attach/兜底 dispatch | `tools/browser/tool-dispatch.ts:74-75` | text 塞 JSON{mime,base64} |
| browser headless worker | `tools/browser/<driver>.executeOnce` 返回 → `tool.ts:195` | text 塞 JSON{mime,base64} |

再无其他 ImageBlock 构造点（`grep "type:'image'"` 全 server src 仅 4 处：image-block.ts 内部 + 上述 2 调用方 + protocol-encode 翻译）。`see_image` 工具不构造 ImageBlock（只 text 输出理解结果）。

**Q3 落盘设计**：
- 路径：**`<ctx.workdir>/snapshots/<toolCallId>.<ext>`**。`ctx.workdir` = `session.workspaceDir`（或 `<DATA_DIR>/workspace` 回退，由 session-config.ts:234 统一）—— 与 `bash`/`file`/`see_image` 工具同根，**相对路径 `snapshots/<toolCallId>.png` 即可被 see_image 解析**（`see_image` 的 `resolveImagePaths` 接受相对 workdir 路径，`tool.ts:170`）。
- 命名：**`<toolCallId>.<ext>`**（无时间戳、无随机）。`toolCallId` 来自 LLM tool_call id（`ToolCallBlock.id`，engine.ts:310 已用），record/replay 下 LLM stub 返回相同 id → 路径确定性 → 不踩 memory `record-replay-dynamic-marker-breaks-stub` 陷阱。
- 目录：**扁平**（不按 session/run 分子目录）。toolCallId 跨 session 唯一；session 维度可后续清理工具扫，本版不做。
- 扩展名：按 `mediaType` 推导（`image/png` → `.png`、`image/jpeg` → `.jpg`；其余兜底 `.png`）。
- 清理：**本版不做**（out of scope）。snapshots 累积在 workdir（dev 重置、prod 用户可清），后续可加 LRU/按 session 清理工具。change_plan 留 TODO 不实例。

**Q4 多模态看图方案**：**统一落盘**（所有模型截图都存路径、tool_result 纯 text；主对话上下文永无 ImageBlock）。
- 多模态模型要看图 → 显式调 `see_image` 工具，入参 `imagePaths:['snapshots/<toolCallId>.png']`。`see_image` 当前已支持 workspace 相对路径（见 Q3），**无需适配**。
- 纯文本模型（M3）只读 AX 树/路径文本即可决策，不调 see_image 也不影响能力。
- **不做**「按模型能力分流」（视觉模型仍 inline）——分流破坏 INV「主上下文永不 inline image」且复杂度倍增。

**Q5 tool_result text 格式**：
- computer screenshot：`Saved screenshot to snapshots/<toolCallId>.png (<width>x<height>, <mediaType>). Use see_image tool to view it.`
- computer get_app_state：`[TextBlock(path+size), TextBlock(axText)]`（保留两块，语义清晰）
- browser screenshot：`Saved browser screenshot to snapshots/<toolCallId>.png. Use see_image tool to view it.`（driver 不返尺寸，不带 size）

**Q6 computer + browser DRY**：**新建** `tools/snapshot-store.ts`（顶层共享模块，被 `computer-use/actions/*` 和 `browser/{tool-dispatch, tool}` 两族消费）。**删除** `tools/computer-use/image-block.ts`（wrapScreenshot 全删，不遗留死代码）。

### INV 不变量（实现 + review 硬约束）
- **INV-157-1**：tool_result.content[] **绝不**含 ImageBlock（computer + browser 全覆盖；grep `type:'image'` 在 tools/ 下归零）。
- **INV-157-2**：截图文件名**必**含 toolCallId，**不得**含 `Date.now()`/`Math.random()`/session 乱序源（record/replay 确定性）。
- **INV-157-3**：截图落盘**必**走 `saveSnapshot`（snapshot-store.ts 单一出口），**禁**在 actions/ 或 browser/ 内各自 `fs.writeFile`（DRY + 路径权威）。
- **INV-157-4**：落盘失败（磁盘满/权限）→ tool_result 返 isError=true + 文案；**不**回退到 inline image（根因消除，不 fallback）。
- **INV-157-5**：`see_image` 工具 + tool 协议**不改**（路径语义已兼容，不为本版加适配层）。

## §0.1 破坏性变更
1. **`wrapScreenshot` 函数 + `image-block.ts` 文件**：**删除**。UT 中 `permissions.test.ts` 的 `describe('wrapScreenshot')` 块同步删；`computer.test.ts` screenshot/get_app_state 断言从「ImageBlock content」改为「text content 含路径」。
2. **`dispatchAction` 签名**：增加 `ctx: ToolCtx`（或窄化 `{workdir, toolCallId}`）参数；所有调用方（`tool.ts` 2 处）同步。
3. **`ToolCtx`**：新增可选字段 `toolCallId?: string`（engine.ts 在 per-call 构造时从 `call.id` 注入）。无破坏性（可选字段，旧 UT 仍可）。
4. **browser worker（executeOnce）screenshot 输出语义**：worker 仍返 `r.text = JSON.stringify({mime, data:base64})`（worker boundary 不能传 Buffer，保留现状）；**caller `tool.ts` 在 `action==='screenshot'` 时拦截**：解析 → 落盘 → 替换 r.text 为路径文本。UT `node-worker-driver.e2e.test.ts:88` 原断言 `parsed.data` 非空仍通过（driver 层契约不变；拦截在 tool.ts 层）。

## §1 变更清单（method 级）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tools/snapshot | app/server/src/tools/snapshot-store.ts | saveSnapshot() | 新增 | 落盘截图到 `<workdir>/snapshots/<toolCallId>.<ext>`：入参 `{workdir, toolCallId, data: Buffer \| base64String, mediaType}`，归一 Buffer（base64 → Buffer.from），mkdir -p snapshots 目录，写文件，返 `{absPath, relPath, size}`。落盘失败抛（caller 转 errorResult） | MUST 单一出口；MUST 用 toolCallId 命名；MUST NOT 含 Date.now/random；MUST 异步（fsp）；Mkdir recursive；INV-157-2/3/4 | INV-157-2/3；memory record-replay-dynamic-marker-breaks-stub | +55 |
| tools/snapshot | app/server/src/tools/snapshot-store.ts | formatSnapshotText() | 新增 | 构造 tool_result 文案：`Saved screenshot to <relPath> (<W>x<H>, <mediaType>). Use see_image tool to view it.`；W/H 可选（browser 不带）；browser 标签可选 | MUST 输出纯 text（无 image block）；路径相对 workdir | INV-157-1 | +20 |
| tools/snapshot | app/server/src/tools/snapshot-store.ts | SnapshotSaveResult (type) | 新增 | 返回值类型 `{absPath, relPath, width?, height?, mediaType}` | — | — | +8 |
| tools/types | app/server/src/tools/types.ts | ToolCtx.toolCallId | 新增（字段） | `toolCallId?: string` 加到 ToolCtx interface；engine 在 per-call 构造时从 `call.id` 注入；注释：screenshots 落盘命名用（snapshot-store 消费） | MUST 可选（不破坏旧 UT）；缺省时 snapshot-store 用 fallback `'unknown-'+Date.now()` 并 log warn（仅 dev 诊断，不影响主路径） | engine.ts:310 已用 call.id 同源 | +6 |
| tools/engine | app/server/src/tools/engine.ts | ToolExecutionEngine.execute() ctx 构造 | 修改 | per-call ctx（L176-181）补 `toolCallId: call.id`；唯一注入点 | MUST 从 call.id 取；不引入第二源 | engine.ts:176-181 | +1/-0 |
| tools/computer-use | app/server/src/tools/computer-use/image-block.ts | (整文件) | 删除 | 删 wrapScreenshot + 文件本体（无死代码） | MUST 同步删所有 import；MUST 确认无残留引用（grep 归零） | 原则：不遗留死代码 | -27 |
| tools/computer-use | app/server/src/tools/computer-use/actions/screenshot.ts | handleScreenshot() | 修改 | ① 删 `wrapScreenshot` import；② 截图成功后调 `saveSnapshot({workdir: ctx.workdir, toolCallId: ctx.toolCallId, data: shot.data, mediaType: shot.mediaType})`；③ 返 `{content:[{type:'text', text: formatSnapshotText({relPath, width:shot.width, height:shot.height, mediaType})}], isError:false}`；④ 落盘失败 catch → errorResult | MUST tool_result.content 仅 1 TextBlock（无 ImageBlock）；MUST 经 saveSnapshot（INV-157-3）；保留坐标上下文缓存逻辑（setComputerCoordContext 不变） | INV-157-1/3；screenshot.ts:43 | +12/-4 |
| tools/computer-use | app/server/src/tools/computer-use/actions/get-app-state.ts | handleGetAppState() | 修改 | ① 删 `wrapScreenshot` import；② `res.screenshot` 存在时调 `saveSnapshot` → push TextBlock(formatSnapshotText + size)；③ push 第二块 TextBlock(axText) 不变；④ 落盘失败 catch → errorResult | MUST 图+树合一保留（2 TextBlock）；axText 缺省空串逻辑不变 | INV-157-1；get-app-state.ts:44 | +10/-2 |
| tools/browser | app/server/src/tools/browser/tool-dispatch.ts | dispatchAction() | 修改 | ① 签名增 `ctx: ToolCtx` 参数（最末位）；② `case 'screenshot'`：调 `saveSnapshot({workdir: ctx.workdir, toolCallId: ctx.toolCallId, data: r.data /* Buffer */, mediaType: r.mime})` → `textResult(formatSnapshotText({relPath, mediaType: r.mime, source:'browser'}))`；③ 落盘失败 catch → errorResult | MUST 接收 ctx；MUST 走 saveSnapshot；保留其他 action 不变； INV-157-1/3 | tool-dispatch.ts:72；INV-157-3 | +12/-3 |
| tools/browser | app/server/src/tools/browser/tool.ts | createBrowserTool().run() attach 分支 | 修改 | `return dispatchAction(r.session, action, typed)` → `return dispatchAction(r.session, action, typed, ctx)` | MUST 透传 ctx | tool.ts:183 | +1/-1 |
| tools/browser | app/server/src/tools/browser/tool.ts | createBrowserTool().run() headless executeOnce 分支 | 修改 | executeOnce 返 ok 后（L195）：`if (action === 'screenshot' && r.ok && r.text)` → 解析 `JSON.parse(r.text)` → `{mime, data:base64}` → `saveSnapshot({workdir:ctx.workdir, toolCallId:ctx.toolCallId, data: Buffer.from(parsed.data,'base64'), mediaType:parsed.mime})` → `textResult(formatSnapshotText({relPath, mediaType:parsed.mime, source:'browser'}))`；解析/落盘失败 → errorResult；其他 action 保持 `textResult(r.text)` | MUST 仅 screenshot action 拦截（其他 action 不变）；MUST 走 saveSnapshot；MUST NOT 改 driver.executeOnce 协议（worker boundary 不动，UT 兼容） | tool.ts:194-196；INV-157-3 | +18/-1 |
| tools/browser | app/server/src/tools/browser/tool.ts | createBrowserTool().run() headless 兜底 connect 分支 | 修改 | `return await dispatchAction(session, action, typed)` → `return await dispatchAction(session, action, typed, ctx)` | MUST 透传 ctx（兜底路径同 attach） | tool.ts:202 | +1/-1 |
| tests/tools | app/server/src/tools/snapshot-store.test.ts | (新文件) | 新增 | UT：① 落盘成功 → 文件存在 + 内容正确 + 返 relPath='snapshots/<id>.png'；② base64 输入归一；③ mediaType→扩展名映射（png/jpg/fallback）；④ 重复 toolCallId 覆盖写；⑤ mkdir recursive（snapshots 不存在自动建）；⑥ toolCallId 缺省 fallback（含 Date.now）路径模式；⑦ formatSnapshotText 各分支（带/不带 size、browser/computer 标签） | MUST 不触真实截图（用假 data）；MUST 用 tmpdir 隔离；INV-157-2 验证 | INV-157-2/3 | +90 |
| tests/computer-use | app/server/src/tools/computer-use/__tests__/computer.test.ts | screenshot 用例（L189-199） | 修改 | 改断言：`imgData(r)` → 改为 `text(r)` 包含 `snapshots/` + `see_image` + (width x height)；mock ctx 加 `toolCallId:'call_test_1'` + workdir 指向 tmpdir；验证文件落盘 | MUST 验证落盘（not just text）；保留 `screenshot` 被 `toHaveBeenCalledWith({app:'Safari'})` 断言 | computer.test.ts:189 | +8/-3 |
| tests/computer-use | app/server/src/tools/computer-use/__tests__/computer.test.ts | screenshot !ok 用例（L201-206） | 修改 | 不变（port.screenshot !ok 路径不触 saveSnapshot） | — | — | +0/-0 |
| tests/computer-use | app/server/src/tools/computer-use/__tests__/computer.test.ts | get_app_state 用例（如有图断言） | 修改 | 改断言 ImageBlock → 2 TextBlock（path + axText）；如无现成 case 补一条 | MUST 两 TextBlock 顺序：[path, axText] | computer.test.ts 现有 get_app_state describe | +6/-2 |
| tests/computer-use | app/server/src/tools/computer-use/__tests__/permissions.test.ts | describe('wrapScreenshot') | 删除 | 整块删（L56-67）+ 删 import `wrapScreenshot`；保留 checkPermissionGate / formatPermissionMissing 测试 | MUST 文件无 wrapScreenshot 残留引用；文件可考虑改名为 permissions.test.ts（保持） | permissions.test.ts:8,56-67 | -14 |
| tests/browser | app/server/src/tools/browser/__tests__/browser-tool.test.ts | (新增 screenshot 用例) | 新增（如当前无） | 加 1 个 attach-mode screenshot 用例：mock session.screenshot 返 `{mime, data:Buffer}` + mock ctx → 验证 tool_result text 含 `snapshots/` + 文件落盘 + 不含 base64 | MUST 不触真实 playwright；MUST 验证 text 不含 base64 字串 | INV-157-1 | +35 |

## §2 影响面评估

### 跨模块
- **tools/** 核心：snapshot-store 新增（共享），computer-use 2 actions 改，browser tool-dispatch + tool.ts 改。
- **tools/types.ts + engine.ts**：ToolCtx 扩字段 + 注入（1 行）。
- **message/types.ts ImageBlock**：**不改**（类型保留——多模态 protocol encode 仍需，将来若重启 inline 可用；本版仅 tool 层不再产出）。doc-modifier 阶段在 spec 标注「v0.0.157 起 tool 层不再构造 ImageBlock；类型保留供 protocol 层」。
- **see_image 工具**：**不改**（路径已兼容）。

### 破坏性
- `wrapScreenshot` API 删除（UT 同步）。
- `dispatchAction` 签名变更（外部 mock 驱动的 UT 需同步，但 browser-tool.test.ts 主要走 tool.ts 入口，影响小）。

### 依赖顺序（波次）
- **波次 A**（底层，无依赖）：snapshot-store.ts + UT → types.ts ToolCtx 扩字段 + engine.ts 注入。
- **波次 B**（消费层，依赖 A）：computer-use/actions/{screenshot,get-app-state}.ts + image-block.ts 删除 + 2 UT 改造。
- **波次 C**（消费层，依赖 A，可与 B 并行）：browser/tool-dispatch.ts + tool.ts + browser-tool.test.ts 新增。
- 三波次内独立 task 可并行（planner 切 3-4 个 task）。

### 风险点
1. **headless 模式 worker boundary**：driver.executeOnce 不能传 Buffer（worker → main 序列化），base64 字符串往返是既定约束——本版在 caller 层解码落盘，不改 worker 协议（保 UT 兼容）。
2. **dev 重置 workdir**：snapshots 累积在 workdir；dev 每次 reset workspace 会清（非问题）；prod 用户 workdir 持久，需后续清理工具（TODO，非本版）。
3. **toolCallId 缺省回退**：engine 一定注入 `call.id`；仅在 ToolCtx 被外部 mock 跳过 engine 时才走 fallback——UT 需显式传 toolCallId（已在 change_plan 标 mock 要求）。
4. **see_image 配置依赖**：若 see_image vender 未配置，多模态模型调 see_image 会 errorResult——非本版问题，文档化即可（tool_result 文案含「Use see_image tool to view it」是引导，非硬约束）。

## §3 测试范围建议

### UT（主验证层）
- `snapshot-store.test.ts`（新增）：覆盖 saveSnapshot 所有分支 + formatSnapshotText。
- `computer.test.ts` 改造：screenshot + get_app_state 落盘验证。
- `browser-tool.test.ts` 新增 attach-mode screenshot 用例（1 条）。
- `permissions.test.ts` 删除 wrapScreenshot describe。
- engine UT：若现有 ctx 构造 UT，补 toolCallId 注入断言（非必须，视现有覆盖）。

### 冒烟集回归（不新增持久 AT/ET）
- 本版**不新增**持久 AT/ET case（内部机制改动，无新 LLM 不确定性场景、无新板块，符合用户铁律）。
- 回归跑现有冒烟集（AT + ET）验证 chat 主链路 + computer/browser 相关 case 不退步。若冒烟集无 computer/browser 截图 case（多半没有），仅做主链路回归。
- 包装相关（packaged）：本版改 server tools 层，**不涉及 plugin/resource/runtime-config/path**，**无需 packaged 验证**（按 CLAUDE.md 持续可打包护栏自检清单：四类风险均不命中）。

### 验收门禁
- UT 全绿（新增 + 改造）。
- 冒烟集 AT ≥ 90% / ET ≥ 70%（版本白名单内）。
- INV-157-1 grep 验证：`grep -rn "type:'image'" app/server/src/tools/` 归零（除 snapshot-store 注释外）。
- 手工验证（可选，由 orchestrator 评估）：prod 场景 computer screenshot 不再 400（dev 环境用真实 computerNativePort 跑一遍；如不可得，跳过靠 UT 保证）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 对实现细节有最终决策权（如 snapshot-store 文件名是否拆 formatSnapshotText 到独立文件、UT 具体组织方式），可合理偏离具体行，但**核心约束（INV-157-1/2/3/4）不可擅自偏离**——偏离须报 orchestrator。
