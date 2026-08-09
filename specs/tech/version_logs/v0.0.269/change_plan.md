# v0.0.269 变更计划书 — workspace 文件类型分流 + 团队状态入口挪 chat 浮菜单

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/version_logs/v0.0.269.file_dispatch_nav_status/prd.md`。版本上下文：`states/v0.0.269/context.md`。
> **架构期裁决（PRD 关键口子）**：
> ① **image 二进制读取通道**：复用 GET /workspace/file 加 `?binary=1` → 读 Buffer → `{ content: base64 }`（白名单校验不变，一个 handler 一个分支；服务端小改动 → UT 覆盖确定性契约，不进 AT 持久 case——项目铁律「确定性 HTTP 契约 UT 覆盖」，向 leader 说明）。
> ② **looksBinary 保留（不作主判定）**：前置分流后进 editor 的都是 text 12 格式；looksBinary + 占位 pill 保留为 editor 内防御（.txt 被改名成真二进制时仍提示「无法预览」）——正常用户不触发，防御路径改动反而增回归面。
> ③ **currentMemberId 注入 = float-menu 收 chrome prop**：SectionChatSession L230 渲染 float-menu 时传 `chrome`（父作用域已有）；`currentMemberId = chrome?.memberId || undefined`（studio_member=对端 member id；群聊/playground/academy=null）——不需要新 Context（Provider 在 page-studio 无 chrome；SquadStatusContext 静态数据 268 不动），float-menu 是唯一消费方。
> ④ **SquadStatusEntry 拆解**：268 topbar 入口组件删除——按钮逻辑（badge/读 Context）并入 float-menu 第 4 项，面板逻辑迁新 `ComponentSquadStatusModal`（L3 modal）；squad-status-utils/context 纯函数与 Provider 不动（数据注入 268 架构保持）。
> ⑤ **SquadStatusProvider 无需全局提升**：float-menu 在 SectionChatSession 内渲染（chat 树内），page-studio chat 分支 Provider 天然包裹；playground/academy 无 Provider → useSquadStatus() 返 null → 按钮不渲染（fail-safe，D12）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（workspace / studio / ui-chat） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| workspace | app/web/src/lib/file-format.ts | IMAGE_EXTS + isImagePath() | 新增 | image 白名单 6 格式（png/jpg/jpeg/gif/webp/svg）+ 判定纯函数（basename 扩展名，大小写不敏感，同 getFileFormat 算法） | MUST 纯函数无副作用；MUST 6 格式闭合（非 6 格式图片 .bmp/.tiff 不加入——PRD §6 范围不扩大） | PRD D2/UC-1/2 | +12 |
| workspace | app/web/src/lib/file-format.ts | looksBinary() | 保留 | 不删（editor 内防御性检测）；注释更新「前置分流后不作主判定，仅 text 白名单内真二进制防御」 | MUST 不作 handleOpen 分流判定（前置分流已挡）；MUST 占位 pill 保留（.txt 改名成二进制时防御提示） | PRD D5；架构裁决② | +0/-1 |
| workspace | app/server/src/handlers/session-workspace-file.ts | handleWorkspaceFileRead() | 修改 | GET 加 `?binary=1` 分支：`readFileSync(absPath)` 返 Buffer → `{ content: buf.toString('base64') }`；非 binary=1 走 utf8 现状 | MUST whitelistResolve 白名单校验不变（binary 与文本同一路径安全面）；MUST binary 仅影响读编码，错误语义（404/400/500）不变；MUST binary 参数缺失/非 '1' → utf8 现状（向后兼容） | PRD D6；架构裁决①；04-agent-session.md §2.6.7 | +5/-1 |
| workspace | app/web/src/lib/chat-api/workspace-api.ts | readWorkspaceFileBinary() | 新增 | `GET /session/:id/workspace/file?binary=1&path=...` → `{ content: base64 }`（复用 req 封装 + whitelistResolve 单一权威） | MUST 与 readWorkspaceFile 同 path 校验语义；MUST 返回 base64 string（前端拼 data URL） | PRD D6；架构裁决① | +12 |
| workspace | app/web/src/components/chat-page/component-ws-image-viewer.tsx（新） | ComponentWsImageViewer | 新增 | L3 modal（Portal + modal shell + 遮罩点击/Esc 关闭）：打开时 readWorkspaceFileBinary → `data:image/{ext};base64,` → `<img>`（max-w/max-h 适配弹层保持纵横比）；标题 = fileName + subtitle；加载失败 → 轻量错误提示（非乱码/占位 pill） | MUST 只读（无编辑/保存/格式化/校验按钮，无 mode-toggle）；MUST 加载中/失败态轻量（loading/error 文案）；MUST data-action-key 关闭/遮罩；MUST testid：ws-image-viewer / ws-image-viewer-img / ws-image-viewer-error | PRD D3/§3.2/UC-1/2 | +95 |
| workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | handleOpen() | 修改 | 前置分流重写：`.url` → openRemoteLink；`isImagePath` → setWsImageTarget；`getFileFormat != null` → openInEditor；其余 → `openWorkspaceItem(sessionId, {path, kind:'file'})`（系统打开，无占位 pill） | MUST 顺序保证（.url 优先 / image 优先 text / text 命中才 editor / 都不命中系统打开）；MUST 文件夹分支不变；MUST 其余系统打开不再进 editor（消灭 looksBinary 占位 pill 触发点） | PRD D1/§3.1/UC-1~6 | +10/-6 |
| workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | wsImageTarget state + 渲染 viewer | 新增 | `useState<WsImageTarget | null>`（{path, fileName, subtitle}）+ `{wsImageTarget && <ComponentWsImageViewer ... onClose={() => setWsImageTarget(null)} />}` | MUST 关闭置空（同 fileEditorTarget 模式）；MUST image 与 editor 目标互斥（同一时刻只开一个） | PRD UC-1/2 | +8 |
| ui-chat | app/web/src/components/chat-page/component-chat-float-menu.tsx | openModal 扩 'squad-status' + 第 4 项按钮 | 修改 | 菜单项加「团队状态」（squad 图标 + running badge），位置 skills 与 todo 之间（**todo 保持最后**）；useSquadStatus() 读 Context——无 Provider → 按钮不渲染（fail-safe）；有 Provider → deriveRunningCount badge（0 态不显数字，绝对定位不占文档流）；点击 setOpen('squad-status') | MUST todo 顺序保持最后；MUST 无 Provider 不渲染（playground/academy fail-safe）；MUST badge 0 态不显数字；MUST data-action-key="chat.squad-status.open" + aria-label/tooltip（floatMenu.squadStatus）；MUST 不新增 SSE 订阅（复用 Provider 已注入 stateMap） | PRD D7/D12/§3.4/UC-7/8/15 | +26/-4 |
| ui-chat | app/web/src/components/chat-page/component-chat-float-menu.tsx | ChatFloatMenuProps + chrome prop | 修改 | props 加 `chrome?: SessionChromeView`（currentMemberId 来源）；内部派生 `currentMemberId = chrome?.memberId || undefined` 传 Modal | MUST 可选 prop（playground/academy 不传 → undefined）；MUST 不破坏现有调用方（SectionChatSession 唯一调用方同步传） | PRD D9；架构裁决③ | +3 |
| ui-chat | app/web/src/components/chat-page/section-chat-session.tsx | L230 float-menu 渲染 | 修改 | `<ComponentChatFloatMenu sessionId={sessionId} hideCron={!caps.cron} chrome={chrome} />`（父作用域 chrome 已存在） | MUST 仅加 chrome prop（其余不变） | PRD D9；架构裁决③ | +1/-1 |
| studio | app/web/src/components/studio-page/component-squad-status-modal.tsx（新） | ComponentSquadStatusModal | 新增 | L3 modal 弹层（Portal + modal shell + 遮罩/Esc 关闭）：面板内容 = 268 迁移（derivePanelRows running 上/idle 下 + PanelRowView presence + hover 进入对话 icon）；**防套娃**：row.member.id === currentMemberId → 不渲染进入对话 icon（行内容保留）；打开时 refreshDetail（fire-and-forget） | MUST 与 268 面板内容一致（分区/行/presence/hover icon 不回归）；MUST currentMemberId 命中行不显示 icon（D9）；MUST 无 deployed 成员空态保留；MUST testid：squad-status-modal / squad-status-row-{memberId}；MUST props = { onClose, currentMemberId } | PRD D8/D9/D10/§3.5/UC-9~12/16 | +110 |
| studio | app/web/src/components/studio-page/section-studio-chat.tsx | topbarLeft 恢复 | 修改 | 撤 SquadStatusEntry：单聊 = MemberAvatar+name+tag（无入口前置）；群聊 = undefined（走 SectionChatSession 缺省 ChatSessionTopbarLeft，恢复 268 前形态） | MUST 268 前 topbarLeft 形态恢复（topbar 不再有成员状态入口，UC-14）；MUST 删 SquadStatusEntry import | PRD D7/UC-14 | +0/-12 |
| studio | app/web/src/components/studio-page/component-squad-status-entry.tsx | SquadStatusEntry | 删除 | 268 topbar 入口组件整体删除（按钮逻辑并入 float-menu 第 4 项；面板逻辑迁 ComponentSquadStatusModal） | MUST grep 无残留引用（section-studio-chat 已撤）；MUST squad-status-utils/context 保留（Modal 复用） | PRD D7；架构裁决④ | -120 |
| ui-chat | app/web/src/i18n/locales/en/chat.json + zh-CN/chat.json | floatMenu.squadStatus + wsImageViewer 键 | 新增 | floatMenu.squadStatus（aria-label/tooltip）；wsImageViewer.title/loadFail/loading/close | MUST en+zh 同步 | PRD §3.2/§3.4 | +12 |
| workspace | app/server/src/handlers/__tests__/session-workspace-file.test.ts | binary 用例 | 新增 | binary=1 → base64 内容正确 / 无 binary → utf8 现状 / 白名单校验不变（traversal 400/not_found 404） | MUST 确定性契约 UT 覆盖（不进 AT 持久 case——项目铁律） | 架构裁决①；04-agent-session.md §2.6.7 | +20 |
| workspace | app/web/src/lib/__tests__/file-format.test.ts | isImagePath 用例 | 新增 | 6 格式 true / 大写扩展名 true / 非 image（.txt/.png.txt/.zip）false / 无扩展名 false | MUST 纯函数全用例 | PRD D2 | +14 |
| workspace | app/web/src/components/chat-page/__tests__/component-ws-image-viewer.test.tsx（新） | viewer UT | 新增 | 渲染 img（mock readWorkspaceFileBinary → base64 → data URL）/ 加载失败 error 文案 / 关闭回调 / 只读无编辑按钮 | MUST mock readWorkspaceFileBinary；MUST jsdom | PRD UC-1/2 | +45 |
| ui-chat | app/web/src/components/chat-page/__tests__/component-chat-float-menu.test.tsx | squad-status 项用例 | 新增 | 有 Provider → 渲染第 4 项 + badge 数字 / 无 Provider → 不渲染 / todo 保持最后 / 点击 → Modal 打开 | MUST 包 SquadStatusContext.Provider mock value；MUST 断言 todo 在 squad-status 后 | PRD UC-7/8/15 | +30 |
| studio | app/web/src/components/studio-page/__tests__/component-squad-status-modal.test.tsx（新） | Modal UT | 新增 | running/idle 分区 / currentMemberId 命中行不显示 icon（防套娃）/ 其他行显示 icon + 点击 onEnterChat / 无 deployed 空态 / 关闭回调 | MUST mock SquadStatusContext；MUST 防套娃断言（currentMemberId 行无 chat icon） | PRD D9/UC-9~12 | +50 |

## 影响面评估

- **改动文件**：3 个新组件/测试文件（image-viewer + squad-status-modal + 2 新 UT）+ 8 个修改（file-format / workspace-api / session-workspace-file / section-workspace-panel / float-menu / section-chat-session / section-studio-chat / i18n×2）+ 1 个删除（squad-status-entry）+ 2 个测试补充 + 6 个 specs 同步（doc-modifier T3）
- **风险点**：
  1. **image 二进制通道（服务端小改动）**：GET /workspace/file 加 binary=1 分支——白名单校验不变（同一 whitelistResolve）；确定性契约 UT 覆盖（session-workspace-file.test.ts），不进 AT 持久 case（项目铁律「确定性 HTTP 契约 UT 覆盖」）；若 leader 坚持可跑一次性真调验证（非持久 case）
  2. **looksBinary 保留**：前置分流后正常用户不触发；.txt 真二进制（改名骗白名单）仍防御提示「无法预览」——与 PRD §3.3「降级提示」倾向有出入（PRD 留架构期定，本裁决=保留现状防御，改动最小不回归）
  3. **float-menu 加 chrome prop**：SectionChatSession 唯一调用方同步传 chrome；playground/academy 传了 chrome 但无 SquadStatusContext → 按钮不渲染（fail-safe）；chrome 是通用类型不破坏
  4. **SquadStatusEntry 删除**：grep 确认无残留引用（section-studio-chat 撤 + 无其他消费方）；squad-status-utils/context 保留（Modal 复用）
  5. **防套娃 currentMemberId**：studio 单聊 = chrome.memberId；群聊 = null；从弹层进入另一成员会话后 memberId 变化 → 新会话的 currentMemberId 正确（float-menu 随 chat 树 remount）；群聊无自己行全部显示 icon（D9）
  6. **handleOpen 分流回归**：.url/text/文件夹路径零变化（除「其余系统打开」新分流）；image 6 格式从 editor 迁 viewer——既有 editor 测试需确认不覆盖 image 路径
- **不做**（PRD §6）：代码文件加 text 白名单 / 非 6 格式图片 / image 编辑/缩略图 / presence SSE / 多 squad 面板 / playground+academy 团队状态 / 成员管理 / 新增 AT/ET 持久 case（ET case 源 = PRD UC-1~16）
