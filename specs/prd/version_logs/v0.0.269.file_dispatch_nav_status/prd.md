# v0.0.269 PRD — workspace 文件类型分流 + 团队状态入口加 chat 浮菜单

> 版本目录：`specs/prd/version_logs/v0.0.269.file_dispatch_nav_status/`
> 需求来源：`reqs/[working] v0.0.269/req.md`（分流表 + 防套娃口径老板已拍板）
> PRD 边界：产品可感知行为；实现细节归架构 change_plan

## 1. 背景

### 1.1 现状问题

**需求 1（文件类型分流 = 一个 bug + 一个需求）**：
- **bug**：点 workspace 里的 `.png` 文件，内置 editor 把二进制内容强 UTF-8 decode 出大量替换符 → `looksBinary`（NUL/\uFFFD >5%）误判 → 显示占位 pill「二进制文件无法预览」——报错形态不对，png 本可用 viewer 打开。
- **需求**：常见图片格式（6 种）在内置 viewer 渲染预览（只读）。
- 根因：`handleOpen` 不看类型一律进 editor（`getFileFormat ?? 'txt'` fallback）→ editor 读内容做内容级判定，缺「按类型前置分流」。

**需求 2（团队状态入口位置修正 = v0.0.268 修正）**：
- v0.0.268 把 Squad 成员状态入口放在了**会话页 topbar**（SquadStatusEntry 挂 SectionStudioChat topbarLeft）——**位置做错了**，老板原始需求是**聊天页右侧那排弹层按钮**（记忆/定时/skills/todo，component-chat-float-menu）。
- 需挪位：入口 = chat 右上浮菜单新按钮（squad 图标 + running badge），位置在 **todo 上方**（todo 保持最后一个）；形态 = 弹层（与这排其他按钮同 base）；topbar 入口撤除；面板内容不变（running 上/idle 下 + presence + hover 进对话 icon）+ 防套娃（列表里「你自己」那一行不显示进入对话 icon）。

### 1.2 目标

1. workspace 文件点开按扩展名前置分流：`.url` 远程链接 → 浏览器（不变）；text 12 格式 → editor（不变）；image 6 格式 → 新 image viewer（只读）；其余一切 → 系统打开（openPath），**无「无法预览」占位报错**。
2. Squad 成员状态入口从会话页 topbar 挪到 **chat 右上浮菜单**（todo 上方，todo 保持最后），点击打开弹层（与这排按钮同 base），面板内容不变；topbar 入口撤除；防套娃：列表里「你自己」那一行不显示进入对话 icon。

### 1.3 范围

- 需求 1：纯前端（handleOpen 分流 + image viewer 组件 + looksBinary 退役评估）。**无后端 API 变更**（open 端点 kind=file 已有，图片读取走 GET /workspace/file 或新增 GET 二进制端点——架构期定）。
- 需求 2：纯前端（float-menu 加按钮 + L3 modal 弹层 + 268 入口组件改造），**无后端 API 变更**。

## 2. 核心产品决策（代决）

### 需求 1：文件类型分流

| # | 决策 | 理由 |
|---|------|------|
| D1 | **handleOpen 前置按扩展名分流**（不再一律进 editor）：`.url` → 浏览器；text 12 格式（getFileFormat 命中）→ editor；image 6 格式 → image viewer；其余 → 系统打开（openWorkspaceItem kind=file） | 判定维度从「内容像不像文本」改为「按类型前置分流」（老板拍板） |
| D2 | **image 白名单 = 6 格式**：`.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg`——浏览器原生 `<img>` 可渲染，零依赖 | 老板拍板；svg 只读预览（不进 text editor 防误编辑） |
| D3 | **image viewer = 只读**（无编辑/保存/格式按钮） | 图片不可文本编辑；svg 防误编辑 |
| D4 | **text 白名单（12 格式）不动**；**范围不扩大铁律**：.java/.ts/.py 等代码文件**不加**进 text 白名单（v0.0.241 铁律「编程语言不做」） | 老板铁律 |
| D5 | **looksBinary 兜底退役**：白名单外不进 editor → 无需内容级判定；`looksBinary` 残留用途 = 仅 image viewer 读二进制成功与否（或彻底删除——架构期评估） | 白名单前置分流后，进 editor 的都是 text 12 格式，内容级判定失去意义 |
| D6 | **image viewer 读文件方式**：图片是二进制，不能走 UTF-8 文本读（GET /workspace/file 返回 string）。需二进制读取（如 GET 返回 base64 / Blob / 或 Electron IPC）——**架构期定**，PRD 定义产品语义 = 点开图片在 viewer 内完整渲染 | 后端 GET /workspace/file 是 UTF-8 文本端点（§2.6.7），读 png 会乱码 |

### 需求 2：团队状态入口加 chat 浮菜单

| # | 决策 | 理由 |
|---|------|------|
| D7 | **入口唯一 = chat 右上浮菜单新按钮**（squad 图标 + running badge），位置在 **todo 上方**（todo 保持最后一个，浮菜单 4→5 个）；会话页 topbar 入口**撤除**（SectionStudioChat topbarLeft 不再挂 SquadStatusEntry） | 老板澄清：原始需求入口 = 聊天页右侧那排弹层按钮（component-chat-float-menu），不是 nav-rail、不是 topbar |
| D8 | **形态 = 弹层（L3 modal base）**：与 memory/cron/skills/todo 弹层同 base（Portal 到 overlay-root + modal shell + 遮罩点击关闭），**不是** 268 的 absolute 下拉面板 | 需求明确「同一套弹层 base」 |
| D9 | **防套娃（Q2 已确认）**：面板列表里「你自己」那一行**不显示进入对话 icon**——判定 = **当前查看的 chat 会话所属的 member**：若用户在 studio 单聊正看着成员 A 的会话，面板里 A 那一行不显示 icon（防套娃：已在其中，点进入=原地跳转）；群聊（memberId 空）不属于任何 member → 无自己行；Studio 首页/Playground/Academy 打开面板（无当前 chat 上下文）→ 无自己行，全部显示 icon | 老板确认按此语义执行 |
| D10 | **面板内容不变**：running 上 / idle 下分区 + presence 文字 + hover 进入对话 icon；badge SSE 实时（复用 session_meta _all stateMap）；benched 不显示 | 268 既有行为不回归 |
| D11 | **数据注入保持 268 架构**：SquadStatusProvider 仍在 page-studio chat 分支包（detail/stateMap/onEnterChat/refreshDetail + 新增 currentMemberId）；float-menu 是 chat 树内组件（SectionChatSession 内渲染），studio 场景自然读到 Context | float-menu 挂在 chat 装配层内，268 Provider 已包裹 chat 子树，无需全局提升 |
| D12 | **无 squad 上下文（playground/academy chat）**：float-menu 有 sessionId 但无 SquadStatusProvider → 团队状态按钮**不渲染**（fail-safe，与 268 SquadStatusEntry 同语义）——团队状态入口只存在于 squad 会话上下文 | 面板数据（squad detail/members/stateMap）只在 studio 有；playground/academy 无 squad 上下文，显示点开是空态的按钮无意义（与 268 fail-safe 一致） |
| D13 | **从弹层点成员进对话 → 跳 Studio 该成员会话落地页**（page-studio onEnterChat = setMainView chat，268 已有）；会话落地页返回键恒回 squad 首页（两级导航语义不变） | 268 语义保留；入口在 chat 浮菜单内，studio chat 场景 onEnterChat 天然可用 |

## 3. 功能需求

### 需求 1：文件类型分流

#### 3.1 handleOpen 前置分流（核心）

点 workspace 文件树节点 → `handleOpen(node)` 按以下顺序分流（**先扩展名、后内容**）：

```
node.type !== 'file' → openWorkspaceItem(kind='folder')（系统文件管理器，现状不变）
isRemoteLinkPath(path)（.url）→ openRemoteLink（浏览器打开，现状不变）
isImagePath(path)（6 格式）→ 打开 image viewer（只读渲染）
getFileFormat(path) != null（text 12 格式）→ 打开内置 editor（现状链路不变）
其余一切（不认识）→ openWorkspaceItem(kind='file')（系统默认应用打开）
```

- **顺序保证**：`.url` 优先于 image/text（.url 不是 image/text）；image 优先于 text（6 格式互斥）；text 命中才进 editor；都不命中 → 系统打开。
- **不认识的类型**（.zip/.bin/.java/.ts/.py 等）→ 系统打开，**无「无法预览」占位 pill**（不再进 editor 触发 looksBinary）。

#### 3.2 image viewer（新组件，只读）

- 点开 6 格式图片 → L3 modal（复用 Portal + modal shell base）内 `<img>` 渲染图片，**只读**：
  - 无编辑/保存/格式化/校验按钮（无 mode-toggle）。
  - 标题 = 文件名 + 相对路径 subtitle；关闭按钮 + 遮罩点击关闭。
  - 加载失败（文件不存在/读取失败）→ 轻量错误提示（如「图片加载失败」），不显示乱码/占位 pill。
- **图片读取**：图片是二进制，不能走 UTF-8 文本端点——需二进制读取通道（架构期定：后端加二进制 GET / 返回 base64 / Blob / Electron IPC 读本地文件）。PRD 只定产品语义：点开图片在 viewer 内**完整渲染**（不裁剪、不缩放失真——`max-w/max-h` 适配弹层，保持纵横比）。

#### 3.3 二进制占位 pill 退役 + looksBinary 评估

- **「二进制文件无法预览」占位 pill 不再出现**：白名单外不进 editor → 无内容级判定触发点。
- `looksBinary` 残留评估（架构期）：text 12 格式进 editor 后理论上都是文本；若保留 `looksBinary` 作防御（如 .txt 实际是二进制）可保留，但**不再是主判定**（PRD 倾向：editor 内保留防御性检测，降级提示而非占位 pill；最终架构期定）。

### 需求 2：团队状态入口加 chat 浮菜单

#### 3.4 chat 浮菜单新按钮（squad 图标 + running badge）

- `ComponentChatFloatMenu` 新增第 **4 项「团队状态」按钮**（squad 图标 + running badge），位置在 **todo 上方**（skills 与 todo 之间；todo 保持最后）→ 浮菜单 = memory / cron / skills / **squad-status** / todo（5 项；cron 仍受 hideCron 控制）。
- badge 数字 = 当前 squad 的 running 成员数含 leader，suspended/benched 不计（268 口径）；badge 0 态不显数字（仅图标）。
- badge SSE 实时：复用 `session_meta _all` 广播（stateMap）——**不新增订阅**。
- 布局稳定：badge 绝对定位叠加（不占文档流，0↔非 0 无位移）；button 语义 + aria-label + tooltip（对齐浮菜单其他按钮）；`data-action-key="chat.squad-status.open"`。
- **无 squad 上下文（playground/academy chat）→ 按钮不渲染**（fail-safe；D12）。

#### 3.5 弹层（L3 modal base，与这排其他按钮一致）

- 点击按钮 → 打开**弹层**（Portal 到 overlay-root + modal shell + 遮罩点击关闭 + Esc 关闭）——与 memory/cron/skills/todo 弹层同一套 base（L3 modal），**不是** 268 的 absolute 下拉。
- **面板内容不变**（迁移 268 面板渲染逻辑到 modal body）：
  - running 上 / idle 下分区（deployed 成员；benched 不显示）。
  - 行 = MemberAvatar + 名字 + role 标识 + presence 文字（currentWork.text 优先，空 i18n fallback）。
  - hover 行 → 右侧出现「进入对话」icon（无文字）→ 点击进入该成员会话。
- **打开弹层时刷新**：触发一次 detail 刷新（presence 尽量新，fire-and-forget）。
- **防套娃（D9）**：`currentMemberId`（当前查看 chat 会话所属 member）那一行**不显示进入对话 icon**；群聊/非会话页 → 全部显示 icon。

#### 3.6 两级导航语义（不变）

- 从弹层点成员进对话 → page-studio `onEnterChat`（setMainView chat）→ 该成员会话落地页（268 已有）。
- 会话落地页返回键 → **恒回 squad 首页**（268 语义不变）。
- topbar 入口撤除后，会话页返回键 + 身份 header 恢复正常（section-studio-chat 恢复 268 前形态）。

#### 3.7 数据注入（架构期口子，保持 268 架构）

- 268 的 SquadStatusProvider 在 page-studio chat 分支包（detail/stateMap/onEnterChat/refreshDetail）——float-menu 是 chat 树内组件（SectionChatSession 内渲染），studio 场景自然读到 Context，**无需全局提升**。
- **新增 `currentMemberId`**：当前查看 chat 会话所属 member id（studio 单聊 = chrome.memberId；群聊/其他 = undefined）——SquadStatusProvider 或入口组件从 chrome 取；防套娃判定用。
- **无 Provider → 按钮不渲染**（playground/academy chat fail-safe，D12）。
- 图片二进制读取通道（需求 1 架构期）。

## 4. 关键用户路径（MANDATORY — ET case 源）

### 需求 1

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | Playground 会话 → ws-panel 文件树点 `.png` 图片 | 打开 image viewer，图片完整渲染（不是文本、不是占位 pill、无编辑入口） |
| UC-2 | 点 `.svg` 图片 | 同样进 image viewer 只读渲染（不进 text editor） |
| UC-3 | 点 `.md` / `.json` 等 12 格式文本 | 既有 editor 链路不变（不回归） |
| UC-4 | 点不认识的类型（`.zip` / `.bin` / `.java`） | 系统默认应用打开；**无「无法预览」占位报错** |
| UC-5 | 点 `.url` 远程链接 | 系统浏览器打开目标 URL（现状不变） |
| UC-6 | 点文件夹 / symlink→dir | 系统文件管理器打开 / 展开浏览（现状不变） |

### 需求 2

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-7 | Studio 单聊/群聊会话页右上浮菜单 | 出现「团队状态」按钮（squad 图标 + running badge），位于 todo 上方（todo 保持最后） |
| UC-8 | 团队有成员 running → 浮菜单 badge 显示数字；另一成员开始/结束运行 → 数字实时 +1/-1（SSE） | badge 实时刷新，无需刷新页面 |
| UC-9 | 点浮菜单「团队状态」按钮 → 弹出成员状态弹层（L3 modal，与 todo 等弹层同 base） | 弹层显示：running 上 / idle 下分区 + presence 文字（与 268 面板内容一致） |
| UC-10 | 弹层中 hover 某成员行（非自己）→ 出现进入对话 icon → 点击 | 进入该成员会话落地页；弹层关闭 |
| UC-11 | 在成员 A 的单聊会话里打开面板 → A 那一行不显示进入对话 icon（其他行显示） | 防套娃：不能点自己会话原地跳转 |
| UC-12 | 群聊会话里打开面板 → 所有成员行都显示进入对话 icon（无自己行） | 群聊不属于任何 member，无防套娃豁免 |
| UC-13 | 从弹层进入的会话点返回键 | 恒回 squad 首页（两级导航，268 语义不变） |
| UC-14 | 会话落地页 topbar | **不再有成员状态入口**（入口唯一 = 浮菜单） |
| UC-15 | Playground / Academy 会话页右上浮菜单 | **无团队状态按钮**（无 squad 上下文，fail-safe 不渲染） |
| UC-16 | 点弹层外遮罩 / Esc | 弹层关闭，当前页面正常使用 |

## 5. 概念对齐 + 新概念

### 概念对齐（复用现有）

| 概念 | 出处 | 复用方式 |
|------|------|---------|
| handleOpen / openWorkspaceItem（kind=file/folder） | `section-workspace-panel.tsx` §4.4 + workspace-api.ts | 分流入口 + 系统打开通道（kind=file 已有） |
| text 12 格式 + getFileFormat / getCategory | `lib/file-format.ts` | text 白名单判定不变；image 白名单新增 |
| L3 modal base（Portal + modal shell） | `component-modal-md-editor.tsx` / `component-todo-modal.tsx` | 新 image viewer + 团队状态弹层复用同套 base |
| chat 浮菜单（memory/cron/skills/todo 4 项 + badge + openModal state） | `component-chat-float-menu.tsx` | 新增第 4 项团队状态（todo 上方）；openModal state 扩 'squad-status' |
| SSE 订阅（session_meta _all） | `use-studio-unread-meta.ts` / sse_client_singleton.md | badge 实时数据源复用（268 Provider 已注入，不新增订阅） |
| 268 面板内容（deriveRunningCount/derivePanelRows/buildMemberChatNode + SquadStatusContext） | `squad-status-utils.ts` / `squad-status-context.ts` | 面板内容整体迁移到浮菜单弹层（不改派生逻辑） |
| isRunning 口径（running/interrupting，suspended 排除） | `use-seats-data.ts` | badge + 分区复用 |
| ChatNode + onEnterChat | `chat-node.ts` / page-studio | 弹层进入对话复用（268 已有） |

### 新概念

| 概念 | 说明 | 需落 spec |
|------|------|----------|
| **image viewer 组件**（新） | 6 格式图片只读渲染 modal（`<img>` + L3 modal base） | `specs/ui/components/chat-page/component-ws-image-viewer.md`（或并入 workspace-panel） |
| **image 白名单 + getFileKind 分流** | file-format.ts 加 `IMAGE_EXTS` + `isImagePath()` / `getFileKind()`（text/image/other） | file-format.ts 注释 + UT |
| **浮菜单团队状态按钮 + 弹层**（改造 268 SquadStatusEntry） | 入口从 topbar 迁浮菜单（todo 上方）；面板从 absolute 下拉改 L3 modal；+ 防套娃（currentMemberId） | 更新 `component-squad-status-entry.md`（挂载点/形态变更）+ `component-chat-float-menu.md`（5 项） |
| **currentMemberId 注入**（新） | SquadStatusContext 增 `currentMemberId?: string`（当前查看 chat 会话所属 member；studio 单聊 = chrome.memberId）——防套娃判定 | squad-status-context.ts 注释 + UT |

## 6. 边界 / 不做

- **范围不扩大铁律（需求 1）**：代码文件（.java/.ts/.py 等）不加 text 白名单；非 6 格式图片（.bmp/.tiff/.ico 等）不加 image 白名单；没明确要求的类型一律不处理。
- **不做 image 编辑**：image viewer 只读，无裁剪/缩放/滤镜/保存。
- **不做 image 缩略图/预览图**：文件树仍显示文件名（不生成缩略图）。
- **不做 presence SSE 实时推送**（268 延续）：presence 文字 = detail 快照 + 打开弹层时刷新。
- **不做多 squad 面板**：面板只显示当前 squad 成员（浮菜单按钮无 squad 切换）。
- **不做 playground/academy 团队状态**：无 squad 上下文 → 按钮不渲染（D12）。
- **不做成员管理**（bench/deploy/编辑——归首页坐席卡菜单）。
- **不新增 AT/ET 持久 case**：本版本 UT+ET（leader 明确要 ET，见验收）；ET case 从本 PRD 关键用户路径产出（UC-1~16 是 ET case 源）。

## 7. 验收口径

**需求 1**：
1. 点 png/jpg 等 6 格式图片 → image viewer 只读渲染（不是文本、不是占位错误、无编辑入口）。
2. 点 12 格式文本 → 既有 editor 链路不变（不回归）。
3. 点不认识的类型（.zip/.bin/.java 等）→ 系统默认应用打开，无「无法预览」报错。
4. looksBinary 占位 pill 不再出现。

**需求 2**：
1. Studio 单聊/群聊会话页右上浮菜单出现团队状态按钮（squad 图标 + running badge，todo 上方，todo 保持最后）。
2. 点击 → 弹层（L3 modal，与 todo 等弹层同 base）：running/idle 分区 + presence + hover 进对话 icon。
3. 会话页 topbar 不再有成员状态入口。
4. 面板功能全保留（268 既有行为不回归）。
5. 防套娃：当前查看会话所属 member 那一行不显示进入对话 icon（群聊/非会话页全部显示）。

**回归不变量**：
1. 现有 ws-panel 打开链路（.url/文本/文件夹）零变化（除「其余系统打开」新分流）。
2. 现有 chat 浮菜单（memory/cron/skills/todo）零变化（新增按钮不破坏）。
3. `session_meta` 订阅不新增（复用现有）。

## 8. spec 对齐备忘

- `component-workspace-panel.md` §4.4：文件点击分流表更新（image 6 格式 + 其余系统打开；二进制降级段改）。
- `component-chat-float-menu.md`：菜单项 4→5（新增团队状态，todo 上方，todo 保持最后）+ openModal state 扩 'squad-status'。
- `component-squad-status-entry.md`：挂载点 topbar → 浮菜单；形态 absolute 下拉 → L3 modal；+ 防套娃（currentMemberId）。
- `section-studio-chat.md`：topbarLeft 恢复（去 SquadStatusEntry）。
- `squad-status-context.ts` 注释：+ currentMemberId。
- `file-format.ts` 注释：image 白名单 + looksBinary 退役评估。
- 新组件 spec：image viewer（需求 1）。

## 9. 版本总结

- **需求 1**：workspace 文件点开按扩展名前置分流（.url → 浏览器 / text 12 → editor / image 6 → 只读 viewer / 其余 → 系统打开），消灭「二进制无法预览」占位 pill；范围不扩大（代码文件不加白名单）。
- **需求 2**：Squad 成员状态入口从会话页 topbar 挪到 **chat 右上浮菜单**（squad 图标 + running badge，todo 上方，todo 保持最后），点击开弹层（与这排按钮同 base），面板内容不变 + 防套娃（当前查看会话所属 member 行不显示进入 icon）；topbar 入口撤除；两级导航语义不变；playground/academy 无 squad 上下文不渲染。
- **风险/口子**：image 二进制读取通道（架构期）；currentMemberId 注入（架构期）；looksBinary 残留用途（架构期）。
