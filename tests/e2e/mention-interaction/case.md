# mention-interaction — @ 面板触发修复 + 文件搜索升级（v0.0.346）

> v0.0.346 关键用户路径 case（test-plan §4 ET-mention-interaction）。纯自然语言 + 定位提示；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位方式（action-key 属性选择器 > 可见文案 > aria-label）。
> 依据：test-plan `states/v0.0.346/verify/test-plan.md` §4 + PRD `specs/prd/v0.0.346-mention-interaction-fix.md` §4（关键路径 11 条）/§5（UC 13 条）。
> 验证环境：worktree `v0.0.346-mention-fix`（分支同名）。

## Use Case

作为 Rocky 用户，我在 Playground 会话输入区敲 `@` 时，mention 面板应该**只由 `@` 字符本身触发**：Esc 取消后面板关闭、继续输入 `1` `2` `3` 不再重弹（bug 修复点）；再次输入新 `@` 又能重新弹出。搜索升级后 `@auth` 应同时命中**文件 + 目录**（目录条目可选中插入 pill），点开头目录（`.rocky_project/` `.claude/` 等）不再被排除；宽泛词命中超 100 条时面板应显示「结果超过 100 条，请细化输入」，细化后无提示、可正常选中插入 pill。

## 前置条件

- env.sh 已起好环境：`bash tests/e2e/env.sh start mention-interaction --mode=headless`（case_id=`mention-interaction`；端口以 env.sh 实际分配为准）。
- 本 case 是**输入区交互**（不依赖 LLM 回复），但建议 LLM provider 可用（minimax 优先），以便需要时发送验证。
- 已有或可新建 **1 个会话**（Playground）。

## 操作目标（编号步骤）

1. **打开会话**：照 `specs/ui/overall/00-app-guide.md` §3.1——nav-rail「Playground」→ 左侧 session 列表选/建一个会话 → 落 chat 页，输入区可见可聚焦。
2. **输入 `@` 触发面板（PRD 路径 #1 / UC-1 前半）**：在输入区键入 `@`。
   - 预期：mention 面板弹出——含 tab 栏（如 Files/Skills）、search input（定位参考 `data-action-key="chat.mention.search"`）、滚动结果列表；默认 activeTab 为第一个 provider（file）。
3. **Esc 取消 + 输 `123` 不重弹（PRD 路径 #2/#3 / UC-1、UC-2）**：焦点在面板 search input（弹出后自动 focus），按 Esc。
   - 预期：面板**关闭**，输入区 `@` 文本**原样保留**。
   - 继续输入 `1` `2` `3`。
   - 预期：**面板不重弹**，输入区正常显示 `@123`（每输一个字符都不弹）。
4. **新 `@` 重触发 + 文件/目录命中（PRD 路径 #4/#5 / UC-3、UC-6）**：在 `@123` 后（或光标新位置）再键入 `@`。
   - 预期：面板**重新弹出**（新 @ 触发）。
   - 在 search input 输入 `auth`。
   - 预期：结果**同时含文件命中项与目录命中项**——目录条目 path 指向目录、display 为目录名（如 `src/auth/` 类条目）；若 worktree 中 `auth` 命中过少，可换同时存在同名文件与目录的词（如 `server` / `config` / `rocky`）。
5. **点开头目录可命中（PRD 路径 #9/#10 / UC-11、UC-12，映射 ET-4）**：清空 search input，输入 `rocky`（或 `.claude` / `.agents` / `.rocky_project` 等点开头目录名）。
   - 预期：可命中点开头目录**本身或其下文件**（如 `.rocky_project/xxx.md` / `.claude/` 下文件）——v0.0.346 排除规则放开（仅 node_modules/.git），点开头不再被排除。
6. **宽泛词超限提示（PRD 路径 #7 / UC-8）**：清空 search input，输入宽泛词（如 `@a` / `@s` / `@c` 单字符）。
   - 预期（条件性）：若命中 **>100 条** → 结果列表底部显示**「结果超过 100 条，请细化输入」**（定位参考 `data-action-key="chat.mention.search-too-many"`；zh 文案，老板钦定逐字）。
   - 若 worktree 命中未超 100：换更宽泛词重试（如 `@e` / `@t`）；仍不超限则记录实际命中条数 + 说明环境未触发超限（此验证点记 small 观察，不阻塞）。
7. **细化 + 选中插入 pill（PRD 路径 #8 / UC-5、UC-9、UC-10）**：细化输入（如 `@auth`，或换一个结果 ≤100 的词）。
   - 预期：**无超限提示**，结果正常展示。
   - 点击/选中一个结果项（文件或目录条目均可）。
   - 预期：输入区插入 **mention pill**（定位参考 `data-mention-node`，显示如 `@auth` 或文件名/目录名胶囊），**面板关闭**；继续输入普通字符**面板不重弹**（选中 = 消费 @，同取消语义）。

## 验收口径（executor 自由心证）

- **pass**：全链路走通无瑕疵——`@` 弹面板 → Esc 取消后输 `123` 不重弹 → 新 `@` 重弹 → `@auth` 结果含文件+目录命中 → 点开头目录可命中 → 宽泛词超限显示「结果超过 100 条，请细化输入」（在超限条件下）→ 细化无提示 → 选中插入 pill 面板关闭。
- **small**：主链路通但有瑕疵不阻塞——如某搜索词未触发超限需换词（环境因素）、超限提示文案与钦定字有微差、pill 样式微差、结果目录条目图标非预期但可选中。
- **blocking**：`@` 不弹面板 / **Esc 取消后输 `123` 仍重弹（核心 bug 回归）** / 新 `@` 不重弹 / `@auth` 无结果或仅文件无目录 / 点开头目录完全不可命中 / 超限条件下无提示 / 选中不插入 pill / 面板无法关闭。

## 留证要求（每步 4 件套）

- 目录：`states/v0.0.346/verify/e2e/mention-interaction/steps/NN-<action>/`（NN=01..07，action 见上；步骤 4/5/6 若拆子动作可加 `-a`/`-b`）。
- 每步：`screenshot.png`（playwright-cli screenshot）+ `dom.html`（eval outerHTML）+ `snapshot.yml`（playwright-cli snapshot）+ `meta.json`（{step, action, intent, playwright_cmd, console_errors, my_observation, verdict}）。
- 关键断言留证点：
  - 面板弹出：snapshot/dom 含 search input（`chat.mention.search`）或可见 tab 栏。
  - 面板关闭：snapshot 中面板元素消失。
  - `@123` 不重弹：输完 3 个字符后 snapshot 无面板元素 + 输入区文本 `@123`。
  - 文件+目录命中：snapshot 结果列表同时有文件项与目录项（目录条目 display 为目录名）。
  - 超限提示：snapshot/dom 含「结果超过 100 条，请细化输入」或 `chat.mention.search-too-many`。
  - pill 插入：snapshot/dom 含 `data-mention-node` 或可见 pill 胶囊。
- **视觉判定**：一律用 `tests/e2e/vision_check.py`（需 `set -a; . ~/.rocky_agent/test.secrets.env; set +a` 注入 VISION_AUTH_TOKEN）；**禁 MCP / 禁 Read 截图**（截图只留证不判读）。

## 依赖

- specs/ui/overall/00-app-guide.md §3.1（Playground 路径）
- specs/ui/components/chat-page/chat-composer.md（输入区契约 / @ 触发 / pill 节点）
- specs/ui/components/chat-page/mention-popover.md（面板契约：tab / search / 结果列表）
- specs/ui/components/chat-page/mention-pill.md（pill 渲染契约）
- specs/tech/mention/provider-interface.md（MentionItem 结构：文件/目录条目 type='file' + path）
- specs/api/mention/GET-search.md（`truncated?: boolean` 响应语义）
