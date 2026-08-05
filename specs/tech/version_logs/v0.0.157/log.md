# v0.0.157 — Tech Change Log（computer/browser 截图本地化：不 inline 进对话上下文）

> 跨版本发布说明（版本轴）。本目录级变更见：
> - `specs/tech/agent/tools/log.md`（2026-07-16 块）
> - `specs/tech/agent/message/log.md`（2026-07-16 块）
> - `specs/tech/agent/platform/log.md`（2026-07-16 块）
>
> 权威变更契约见同目录 `change_plan.md`（17 method 级行 + 5 INV + 2 破坏性变更）。

## 概览

**根因**：prod 用 MiniMax-M3（纯文本模型），computer 工具截图经 `image-block.ts:wrapScreenshot` 包成 ImageBlock inline 进 `tool_result.content` → provider 400「Model only support text input」每轮复现（session `01KXJZCFVST8SQVD4SKGWVDP0E` 实证，最新 transcript 含 5 条 image tool_result，上下文 107k/300k 未压缩）。同根因波及 browser 截图（`tool-dispatch.ts` / headless worker `tool.ts` 把 base64 塞 textResult 的 text，虽不触发 400 但 token 暴增 + 对 LLM 无用）。

**方案**：截图统一落盘 `<workdir>/snapshots/<toolCallId>.<ext>`，tool_result 改纯 text（路径）；多模态模型按需显式调 `see_image` 读路径看图；主对话上下文永无 ImageBlock。新建共享 `tools/snapshot-store.ts`（saveSnapshot + formatSnapshotText，INV-157-3 单一落盘出口），删 `image-block.ts`（无死代码）。

**设计 INV**（实现 + review 硬约束，见 change_plan §0 INV-157-1..5）：

- **INV-157-1**：tool_result.content[] 绝不含 ImageBlock（computer + browser 全覆盖；grep `type:'image'` 在 tools/ 归零）。
- **INV-157-2**：截图文件名必含 toolCallId，禁 Date.now/Math.random（record/replay 确定性；LLM stub 返相同 id → 路径稳定）。
- **INV-157-3**：落盘必走 saveSnapshot（snapshot-store.ts 单一出口），禁 actions/browser 内各自 fs.writeFile。
- **INV-157-4**：落盘失败 → isError=true 文案，不回退 inline image（根因消除，不 fallback）。
- **INV-157-5**：see_image 工具 + tool 协议不改（路径语义已兼容 see_image 的 resolveImagePaths）。

## §1 影响面（method 级，详 change_plan §1）

### tools/snapshot（新增共享模块）
- **`app/server/src/tools/snapshot-store.ts`（新文件）**：
  - `saveSnapshot({workdir, toolCallId, data: Buffer|base64, mediaType, width?, height?})` → mkdir -p `<workdir>/snapshots/` + writeFile `<toolCallId>.<ext>`（ext 按 mediaType 推导：png/jpg/fallback .png）→ 返 `{absPath, relPath, mediaType, width?, height?}`。toolCallId 缺省 fallback `'unknown-'+Date.now()` 并 warn（仅 dev 诊断；engine 主路径一定注入 call.id）。
  - `formatSnapshotText({relPath, width?, height?, mediaType?, source:'computer'|'browser'})` → 构造 tool_result 文案。computer 形态：`Saved screenshot to <relPath> (<W>x<H>, <mediaType>). Use see_image tool to view it.`（有尺寸才带 size 段）；browser 形态：`Saved browser screenshot to <relPath>. Use see_image tool to view it.`（driver 不返尺寸，固定无 size 段）。

### tools/types + engine（ToolCtx 扩字段）
- **`app/server/src/tools/types.ts` `ToolCtx`**：新增可选字段 `toolCallId?: string`。注释：engine per-call 从 `ToolCallBlock.id`（call.id）注入，唯一注入源；snapshot-store 落盘命名消费。可选字段（不破坏旧 UT）。
- **`app/server/src/tools/engine.ts:executeOne ctx 构造`**：per-call ctx 补 `toolCallId: call.id`（唯一注入点，单行）。

### tools/computer-use（消费 snapshot-store + 删 image-block.ts）
- **`actions/screenshot.ts handleScreenshot()`**：删 `wrapScreenshot` import；截图成功后调 `saveSnapshot({workdir: ctx.workdir, toolCallId: ctx.toolCallId, data: shot.data, mediaType, width, height})` → 返 `{content:[TextBlock(formatSnapshotText({relPath, width, height, mediaType}))], isError:false}`；落盘失败 catch → errorResult。保留 `setComputerCoordContext` 坐标缓存逻辑。
- **`actions/get-app-state.ts handleGetAppState()`**：删 `wrapScreenshot` import；`res.screenshot` 存在时调 `saveSnapshot` → push TextBlock(formatSnapshotText + size)；保留第二块 TextBlock(axText)（两 TextBlock 顺序固定 [path, axText]）；落盘失败 catch → errorResult。
- **`image-block.ts`（整文件删）**：`wrapScreenshot` + 文件本体全删。同步删所有 import（screenshot.ts / get-app-state.ts / permissions.test.ts / computer.test.ts）。

### tools/browser（dispatchAction 加 ctx + tool.ts 拦截落盘）
- **`tool-dispatch.ts dispatchAction(session, action, typed, ctx)`**：签名增 `ctx: ToolCtx` 最末位（兼容性破坏，所有调用点同步）。`case 'screenshot'`：调 `saveSnapshot({workdir: ctx.workdir, toolCallId: ctx.toolCallId, data: r.data /* Buffer */, mediaType: r.mime})` → `textResult(formatSnapshotText({relPath, source:'browser'}))`；落盘失败 catch → errorResult。其他 action 不消费 ctx。
- **`tool.ts createBrowserTool().run()` 三处透传 + 一处拦截**：
  - attach 分支：`dispatchAction(r.session, action, typed, ctx)`（透传 ctx）。
  - headless executeOnce 分支：`action === 'screenshot' && r.ok && r.text` 时拦截 → `JSON.parse(r.text)` → `{mime, data:base64}` → `saveSnapshot({..., data: Buffer.from(parsed.data,'base64'), mediaType: parsed.mime})` → `textResult(formatSnapshotText({relPath, source:'browser'}))`；其他 action 保持 `textResult(r.text)`。**driver.executeOnce 协议未动**（worker boundary 仍返 `JSON.stringify({mime,data:base64})` 作 r.text，Node worker 不能传 Buffer 是既定约束）。
  - 兜底 connect 分支：`dispatchAction(session, action, typed, ctx)`（透传 ctx）。

### message/types（ImageBlock 类型保留，不改）
- **`message/types.ts ContentBlock` union ImageBlock 不改**：类型保留供 protocol 层（llm/protocol-encode encodeContentBlock case 'image' 翻译 spec 形→anthropic wire 形）。本版本仅 tool 层不再产出 ImageBlock；protocol 层在多模态模型场景仍可能从 user 消息（人工构造）/ 未来扩展路径接收 image。

### see_image（不改）
- **`see_image` 工具 + tool 协议不改**：`resolveImagePaths` 已兼容 workspace 相对路径（`path.resolve(workdir, p)`），`snapshots/<toolCallId>.png` 相对路径自动解析。多模态模型按需显式调 `see_image({imagePaths:['snapshots/<id>.png']})` 看图。

## §2 破坏性变更

1. **`wrapScreenshot` + `image-block.ts`**：删除。`permissions.test.ts` 的 `describe('wrapScreenshot')` 块同步删；`computer.test.ts` screenshot/get_app_state 断言从「ImageBlock content」改为「text content 含 `snapshots/` + `see_image` + size」。
2. **`dispatchAction` 签名**：增加 `ctx: ToolCtx` 最末位；3 处调用点（`tool.ts` attach + 兜底 + headless 非 screenshot 路径）同步透传。
3. **`ToolCtx`**：新增可选 `toolCallId?: string`（无破坏性，旧 UT 可选）。
4. **browser worker（executeOnce）screenshot 输出语义**：worker 仍返 `r.text = JSON.stringify({mime, data:base64})`（worker boundary 不能传 Buffer，保留）；caller `tool.ts` 在 `action==='screenshot'` 时拦截 decode+落盘+替换为路径文本。driver.executeOnce 协议不动，`node-worker-driver.e2e.test.ts` 原断言兼容。

## §3 不做的事（范围外）

- **不做按模型能力分流**（视觉模型 inline / 纯文本模型落盘）：分流破坏 INV「主上下文永不 inline image」+ 复杂度倍增。统一落盘。
- **不做 snapshots 目录清理**：累积在 workdir（dev 重置、prod 用户可清）；后续可加 LRU/按 session 清理工具（TODO，非本版）。
- **不改 see_image**：路径已兼容，不为本版加适配层。
- **不改 driver.executeOnce 协议**：worker boundary 不传 Buffer 是既定约束，在 caller 层解码落盘保 UT 兼容。

## §4 测试范围（UT 主 + AT 冒烟回归）

- **UT（主验证层）**：新增 `snapshot-store.test.ts`（saveSnapshot 全分支 + formatSnapshotText）；`computer.test.ts` screenshot/get_app_state 改断言 text + 验证落盘；`browser-tool.test.ts` 加 attach-mode screenshot 落盘用例（+ headless 拦截用例 + 非 screenshot 不拦截用例）；`permissions.test.ts` 删 wrapScreenshot describe。
- **AT 冒烟回归（不新增持久 case）**：本版**不新增** AT/ET case（纯内部机制改动，无新 LLM 不确定性场景）。跑现有冒烟集验证 chat 主链路 + 工具链路不退步。
- **ET 豁免**（用户裁决 2026-07-16）：本版本只改 server tools，前端零改动，ET 测前端 E2E 无意义。
- **packaged 豁免**：本版改 server tools 层，不涉及 plugin/resource/runtime-config/path，无需 packaged 验证（持续可打包护栏四类风险均不命中）。

### 验收门禁实测结果
- UT：tools 748 passed / 4 skipped；typecheck 零错。
- AT 冒烟（86.5s replay 全扫）：8 pass / 2 fail。关键证据 `chat_send_tool`（工具调用主路径）pass + `agent_spawn_sync` / `auto_naming` 等 pass → engine ctx 改动**没破坏工具链路**。
- 2 fail 均基线债、非本版本引入（`si1_minimax_multi_image` drift=True，recordings 录于 07-14 桩协议演进致 available_0 不匹配，see_image 代码本版未动；`t2_daily_consolidation` LLM 收敛 flaky，consolidation 代码本版未动）。基线债不进本版本门禁、不在本分支修（祖先链归因）。
- INV-157-1 grep 验证：`grep -rn "type:'image'" app/server/src/tools/` 归零（除 snapshot-store.ts 注释）。
- INV-157-3 单一出口验证：`saveSnapshot` 是 tools/ 下唯一截图落盘函数，actions/browser 内无裸 fs.writeFile（仅 snapshot-store.ts + file-write/file-edit 走 atomicWriteSync 与本版无关）。

## §5 spec 同步清单（doc-modifier）

| KB / 目录 | 文件 | 变更 |
|---|---|---|
| tech/agent/tools | `[P0]tool_execution_engine.md` §2 | ToolCtx 加 `toolCallId?: string` 字段 + 注释（engine 从 call.id 注入，snapshot-store 落盘命名用） |
| tech/agent/tools | `[P1]computer_use_tool.md` §2/§4/§7 | action 表 screenshot/get_app_state 结果包装改 text（落盘路径）；run() 示例改 saveSnapshot + formatSnapshotText；文件清单删 image-block.ts + 加 actions 改 saveSnapshot 说明 |
| tech/agent/tools | `[P1]browser_tool.md` §2/§7 | BrowserSession.screenshot 注释改「路径文本，不 inline」；§7 tool 层 run() 示例补 headless screenshot 拦截落盘 + dispatchAction ctx 透传 |
| tech/agent/tools | `index.md` ④/⑤ | 加核心原则 11（截图不 inline 进上下文，统一落盘）；导航 computer_use_tool/browser_tool 描述补「v0.0.157 落盘」 |
| tech/agent/tools | `log.md` | 加 2026-07-16 v0.0.157 条目 |
| tech/agent/message | `[P0]agent_message_interface.md` §4.2 | ImageBlock 加说明「tool 层 v0.0.157 起不再构造；类型保留供 protocol 层」 |
| tech/agent/message | `log.md` | 加 2026-07-16 v0.0.157 条目 |
| tech/agent/platform | `[P1]computer_native_capability.md` §2 | ComputerScreenshotResult.data 注释改「tool 经 saveSnapshot 落盘」（去掉「直接进 ImageBlock.source.data」过时描述） |
| tech/agent/platform | `log.md` | 加 2026-07-16 v0.0.157 条目 |
| api/overall | `18-computer-use.md` §4 | AT 断言从 ImageBlock 改为 TextBlock（路径文本） |
| ui/components/chat-page | `_overview.md` §4.9 | ImageBlock UI 渲染分支标注「tool 层 v0.0.157 起不再产出；保留渲染供 protocol 层/未来扩展」 |

## §6 验证结论

- 所有 task code-review CONDITIONAL PASS（9 处 Minor 直接修：Rule H 版本前缀噪声清理 + snapshot-store hasId 简化）。
- AT 冒烟回归达阈值（≥90%），2 fail 为基线债非本版本引入。
- code-spec 一致核实：INV-157-1 grep 归零 + INV-157-3 单一落盘出口 + 无残留 wrapScreenshot / image-block 引用。
