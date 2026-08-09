# v0.0.269 tech change log — workspace 文件类型分流 + 团队状态入口挪 chat 浮菜单

> 对应需求：`reqs/[working] v0.0.269/req.md`（用户可感知的行为改动 → 走完整 PRD）。
> PRD：`specs/prd/version_logs/v0.0.269.file_dispatch_nav_status/prd.md`。
> 权威契约：`specs/tech/version_logs/v0.0.269/change_plan.md`（method 级 18 行表，frozen）。
> 新组件 spec：`specs/ui/components/chat-page/component-ws-image-viewer.md` + `specs/ui/components/studio-page/component-squad-status-modal.md`（架构期已建）。

## 变更摘要

### 需求与动机

v0.0.269 双需求：

1. **workspace 文件类型分流**（需求 1）：文件树点文件存在「二进制无法预览」占位 pill——二进制文件（图片等）点开进 editor 读乱码。需求 = handleOpen 前置按扩展名分流：`.url` 浏览器 / 图片 6 格式只读 viewer / text 12 格式 editor / 其余系统打开，消灭占位 pill。
2. **团队状态入口挪位**（需求 2）：v0.0.268 把 Squad 成员状态入口放在了会话页 **topbar**（SquadStatusEntry 挂 SectionStudioChat topbarLeft）——**位置做错了**，老板原始需求是**聊天页右侧那排弹层按钮**（记忆/定时/skills/todo，component-chat-float-menu）。需求 = 入口从 topbar 挪到 chat 右上浮菜单第 4 项（todo 上方，todo 保持最后），形态 = L3 modal 弹层，面板内容不变 + 防套娃（currentMemberId 命中行不显示进入 icon）。

### 架构期裁决（change_plan 5 口子，PRD 关键决策）

1. **image 二进制读取通道**（裁决①）：复用 GET /workspace/file 加 `?binary=1` → 读 Buffer → `{ content: base64 }`（白名单校验不变，一个 handler 一个分支）；服务端小改动 → UT 覆盖确定性契约，**不进 AT 持久 case**（项目铁律「确定性 HTTP 契约 UT 覆盖」）。
2. **looksBinary 保留（不作主判定）**（裁决②）：前置分流后进 editor 的都是 text 12 格式；looksBinary + 占位 pill 保留为 editor 内防御（`.txt` 被改名成真二进制时仍提示「无法预览」）——正常用户不触发，防御路径改动反而增回归面。
3. **currentMemberId 注入 = float-menu 收 chrome prop**（裁决③）：SectionChatSession 渲染 float-menu 时传 `chrome`（父作用域已有）；`currentMemberId = chrome?.memberId || undefined`（studio_member=对端 member id；群聊/playground/academy=null）——不需要新 Context（Provider 在 page-studio 无 chrome；SquadStatusContext 静态数据 268 不动）。
4. **SquadStatusEntry 拆解**（裁决④）：268 topbar 入口组件删除——按钮逻辑（badge/读 Context）并入 float-menu 第 4 项，面板逻辑迁新 `ComponentSquadStatusModal`（L3 modal）；squad-status-utils/context 纯函数与 Provider 不动（数据注入 268 架构保持）。
5. **SquadStatusProvider 无需全局提升**（裁决⑤）：float-menu 在 SectionChatSession 内渲染（chat 树内），page-studio chat 分支 Provider 天然包裹；playground/academy 无 Provider → useSquadStatus() 返 null → 按钮不渲染（fail-safe，D12）。

### T1 — workspace 文件类型分流 + image viewer + 二进制通道（commit e081befd0）

- **`lib/file-format.ts`**：加 `IMAGE_EXTS`（6 格式闭合 png/jpg/jpeg/gif/webp/svg）+ `isImagePath(path)`（basename 扩展名大小写不敏感，无扩展名 false）——image 分流判定；`looksBinary` **保留**（注释更新「前置分流后不作主判定，仅 text 白名单内真二进制防御」）。
- **`server/src/handlers/session-workspace-file.ts`**：GET 加 `?binary=1` 分支——`readFileSync(absPath)` 读 Buffer → `{ content: buf.toString('base64') }`；非 binary=1 走 utf8 现状（向后兼容）；whitelistResolve 白名单校验不变（binary 与文本同一路径安全面）。
- **`lib/chat-api/workspace-api.ts` `readWorkspaceFileBinary` NEW**：`GET /session/:id/workspace/file?binary=1&path=...` → `{ content: base64 }`。
- **`chat-page/component-ws-image-viewer.tsx` NEW（148 行）**：L3 modal（Portal + modal shell + 遮罩/Esc/关闭三路）+ 打开 `readWorkspaceFileBinary` → `data:image/{ext};base64,` → `<img>`（max-w/max-h 保持纵横比）；mediaTypeFromPath 6 格式映射兜底 octet-stream；只读（无编辑/保存/格式化/校验）；失败轻量 error。testid：ws-image-viewer / ws-image-viewer-img / ws-image-viewer-error。
- **`chat-page/section-workspace-panel.tsx` handleOpen 五路分流**：`node.type !== 'file'`（文件夹）→ openWorkspaceItem(kind='folder')；`isRemoteLinkPath`（.url）→ openRemoteLink（嗅探失败降级 editor）；`isImagePath`（6 格式）→ `setWsImageTarget`（与 fileEditorTarget 互斥）；`getFileFormat !== null`（12 格式文本）→ setFileEditorTarget；其余 → openWorkspaceItem(kind='file') 系统打开（**无占位 pill**）。

### T2 — 团队状态入口挪 chat 浮菜单（coder2，偏离 4 项等价合理）

- **`chat-page/component-chat-float-menu.tsx` 第 4 菜单项「团队状态」**：skills 下方、todo **上方**（todo 保持最后，共 5 项）；`useSquadStatus()` 读 SquadStatusContext（page-studio chat 分支 Provider 下传；**无 Provider → 按钮不渲染 fail-safe**）；running badge = `deriveRunningCount`（deployed isRunningState 计数含 leader，0 态 Badge 不渲染不占位）；`openModal` 扩 `'squad-status'`；props 加 `chrome?: SessionChromeView`（`currentMemberId = chrome?.memberId ?? undefined` 防套娃）。data-action-key="chat.squad-status.open"。
- **`chat-page/section-chat-session.tsx`**：渲染 float-menu 传 `chrome={chrome}`（L231）。
- **`studio-page/component-squad-status-modal.tsx` NEW**：面板逻辑自 entry 迁本组件——L3 modal（Portal + modal shell + 遮罩/Esc/关闭三路）+ running 上 / idle 下分区（derivePanelRows）+ presence 文字 + hover 进入对话 icon + **防套娃**（`row.member.id === currentMemberId` → 不渲染进入对话 icon，行内容保留）+ 打开 refreshDetail fire-and-forget（ctx null 守卫前无条件调用，hooks 规则）+ 无 Provider 不渲染（双保险）。testid：squad-status-modal / squad-status-row-{memberId}。Props `{ onClose, currentMemberId? }`。
- **`studio-page/section-studio-chat.tsx` topbarLeft 恢复 268 前形态**：`SquadStatusEntry` 删除——单聊 = MemberAvatar+name+tag；群聊 = 显式 ChatSessionTopbarLeft。`component-squad-status-entry.tsx` 删除（按钮逻辑并入 float-menu 第 4 项，面板逻辑迁 modal）；squad-status-utils/context/Provider 不动（数据注入 268 架构保持）。
- **i18n**：`chat:floatMenu.squadStatus`（aria-label/tooltip）+ `chat:workspace.wsImageViewer`（title/loadFail/loading/close）en+zh 同步。

## 设计决策

- **五路分流顺序 MUST**（.url 优先 > image 优先 text > text 命中才 editor > 都不命中系统打开）：文件夹分支不变；image 6 格式从 editor 迁 viewer；其余系统打开不再进 editor（消灭 looksBinary 占位 pill 触发点）。`isBuiltinEditable` 保留 12 格式语义（服务 link-target markdown 链接分发，v0.0.253 契约不变）。
- **image 6 格式闭合（PRD §6 范围不扩大）**：非 6 格式图片（.bmp/.tiff/.ico）走系统打开，不加入 IMAGE_EXTS。
- **binary=1 只影响读编码**：错误语义（404/400/500）不变；binary 参数缺失/非 '1' → utf8 现状（向后兼容）。
- **looksBinary 保留为 editor 内防御**：前置分流后进 editor 的都是文本；`.txt` 改名成真二进制时仍提示「无法预览」——防御路径不动，改动最小不回归。
- **防套娃 currentMemberId**：studio 单聊 = chrome.memberId；群聊/playground/academy = undefined（全部显示 icon）；从弹层进入另一成员会话后 memberId 变化 → 新会话的 currentMemberId 正确（float-menu 随 chat 树 remount）。
- **SquadStatusProvider 不全局提升**：float-menu 在 chat 树内天然被 page-studio chat 分支 Provider 包裹；playground/academy 无 Provider → useSquadStatus() 返 null → 按钮不渲染（fail-safe，D12）。

## 代码↔spec 核实（doc-modifier 阶段 5 — 逐项比对 change_plan + 代码）

| # | change_plan 契约 | 代码实现 | 一致 |
|---|---|---|---|
| 1 | IMAGE_EXTS 6 格式闭合 + isImagePath 纯函数（大小写不敏感） | `file-format.ts:154-174`（L154-161 IMAGE_EXTS / L167-174 isImagePath） | ✅ |
| 2 | looksBinary 保留（注释更新「前置分流后不作主判定，仅 text 白名单内真二进制防御」） | `file-format.ts:182-193` 注释已更新 | ✅ |
| 3 | GET /workspace/file 加 ?binary=1 → Buffer → base64；非 1/缺失 → utf8 | `session-workspace-file.ts:76-87` binary 分支 + 白名单校验不变 | ✅ |
| 4 | readWorkspaceFileBinary（GET ?binary=1 → { content: base64 }） | `workspace-api.ts:144-149` | ✅ |
| 5 | ComponentWsImageViewer（L3 modal + 只读 + loading/error + testid 三件套） | `component-ws-image-viewer.tsx`（148 行）全部对齐 | ✅ |
| 6 | handleOpen 五路分流（folder > .url > image > text > 系统打开；无占位 pill） | `section-workspace-panel.tsx:163-192` 顺序逐字一致 | ✅ |
| 7 | wsImageTarget state + 渲染 viewer（与 fileEditorTarget 互斥） | `section-workspace-panel.tsx:161,293` | ✅ |
| 8 | float-menu 第 4 项「团队状态」（skills 与 todo 之间、todo 最后）+ badge 0 态 + fail-safe | `component-chat-float-menu.tsx:125-140` 顺序正确 | ✅ |
| 9 | ChatFloatMenuProps + chrome prop；currentMemberId = chrome?.memberId | `component-chat-float-menu.tsx:46,167` | ✅ |
| 10 | section-chat-session L230 传 chrome | `section-chat-session.tsx:231` `<ComponentChatFloatMenu ... chrome={chrome} />` | ✅ |
| 11 | ComponentSquadStatusModal（L3 modal + 防套娃 + refreshDetail + testid + props { onClose, currentMemberId }） | `component-squad-status-modal.tsx`（192 行）全部对齐 | ✅ |
| 12 | section-studio-chat topbarLeft 恢复（撤 SquadStatusEntry） | `section-studio-chat.tsx:44-64`（单聊/群聊两态，无 entry） | ✅ |
| 13 | component-squad-status-entry.tsx 删除 | git 确认已删（ls: No such file） | ✅ |
| 14 | i18n floatMenu.squadStatus + wsImageViewer（en+zh） | `chat.json:80` + `chat.json:184-190` 双语 | ✅ |
| 15 | binary UT（base64 还原 + 白名单不变） | `session-workspace-file.test.ts:148-181`（还原==原 Buffer / traversal 400 / missing 404） | ✅ |
| 16 | isImagePath UT（6 格式 true / 大写 true / 非 image false） | `file-format.test.ts:170-180` | ✅ |
| 17 | viewer UT / float-menu squad-status UT / modal 防套娃 UT | 三个测试文件就位（viewer img/error/只读；float-menu 有 Provider/无 Provider/todo 最后；modal currentMemberId 命中行无 icon） | ✅ |

**偏离记录（等价合理，非静默）**：
- **偏离 1（viewer Props 形态）**：change_plan 行 33 契约写扁平 props（sessionId/path/fileName/subtitle/onClose）；实际实现 = `{ sessionId, target: WsImageTarget | null, onClose }`（target 对象含 path/fileName/subtitle，null 不渲染）——等价合理（handleOpen 只 set 一次 target，父组件持 state 更简洁；spec `component-ws-image-viewer.md` 已按实现修正 Props 段）。
- **偏离 2（i18n 键位置）**：change_plan 行 42 写 wsImageViewer 键；实际键在 chat ns `workspace.wsImageViewer.*` 嵌套对象下（viewer 组件 `useTranslation('chat')` + `t('workspace.wsImageViewer.loadFail')`）——等价合理（与 `workspace.mdEditor.*` 同构），spec 已按实现写。
- **偏离 3（T2，coder2 记录）**：i18n 补 `studio.squadStatus.title`（modal 标题用）；entry 测试删除 + section-studio-chat 测试适配；modal Esc 关闭实现（change_plan 未列 Esc 键但「遮罩/Esc 关闭」语义一致）。
- **偏离 4（T1，code-reviewer 记录）**：md 测试语义随 PRD 分流更新（.md 仍 editor，无回归）；coversFiles 路径修正；server handlers 1 failed = pre-existing（git diff 甄别）。
- **偏离 5（code-reviewer2 独立复审）**：i18n en/zh chat.json trailing newline Minor 已修。

## 文档同步（doc-modifier T3）

- 新组件 spec：`specs/ui/components/chat-page/component-ws-image-viewer.md`（架构期已建，T3 修 Props 段对齐 target 对象）+ `specs/ui/components/studio-page/component-squad-status-modal.md`（架构期已建，核实与实现一致）。
- `specs/ui/components/chat-page/component-workspace-panel.md` §4.4：分流表 v0.0.263 二元 → v0.0.269 五路（.url > image > text > 系统打开）+ looksBinary 段改「保留为 editor 内防御」。
- `specs/ui/components/chat-page/component-chat-float-menu.md`：菜单项 4→5（squad-status 在 todo 上方、todo 保持最后）+ openModal 扩 'squad-status' + chrome prop + 复用关系补 squad-status-modal + 挂载方 section-chat-session。
- `specs/ui/components/studio-page/component-squad-status-entry.md`：**删除**（代码已删，modal spec 替代）。
- `specs/ui/components/studio-page/section-studio-chat.md`：topbarLeft 恢复 268 前形态（去 SquadStatusEntry）。
- `specs/ui/components/studio-page/component-seats-panel.md`：buildMemberChatNode 说明「与 SquadStatusEntry 面板」→「与成员状态弹层（component-squad-status-modal）同源组装」。
- `specs/api/overall/04-agent-session.md` §2.6.7：GET /workspace/file 补 `?binary=1` 参数契约（表格 + query param + 行为 step 7 binary 分支 + 五路判定段 + 请求示例）。
- `specs/ui/overall/00-app-guide.md`：§3.2 团队状态入口从 topbar 挪 chat 浮菜单第 4 项（todo 上方）+ 防套娃 + workspace 图片点击走图片 viewer。
- `specs/tech/app/frontend/log.md` + `index.md`：v0.0.269 条目 + 概念行（v0.0.268 概念行修正指向 modal + 补挪位说明）。
- **不做**：AT/ET 持久 case（确定性 HTTP 契约 UT 覆盖铁律；纯前端确定性 UI UT 覆盖）；无其他后端 API 变更。
