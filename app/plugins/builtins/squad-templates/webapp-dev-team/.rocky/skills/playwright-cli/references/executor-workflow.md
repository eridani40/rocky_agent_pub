# ET Executor 工作流详参（新范式）

> 注：本文 case 名 / 端口 / DATA_DIR 前缀均为示例，按项目变量区替换。
> 本文是 `.rocky/agents/e2e-test-executor.md` 的「我怎么干」详参（agent 定义是「我是谁/铁律」）；
> 与 `app-e2e-real-run.md`（用户层「能用」验收）互补，本文聚焦 **executor agent 层** 工作流。
> 命令清单见 `SKILL.md`，本文不重复列举，只讲组合范式与陷阱规避。

## 1. 环境坑清单（5 条，含现象 / 成因 / 绕行）

### 坑 1：playwright-cli open 后无响应 / CDP 端口被占
- **现象**：`playwright-cli open http://...` 卡住，或 attach --cdp 报 port in use
- **成因**：上次跑剩的 chromium / electron 进程残留 listener 占着端口；env.sh stop 已清 server/web，但 CDP 端口（9222-9299）和 browser 自身不在 env.sh 管辖
- **绕行**：
  - 先 `playwright-cli list` 看现有 session，`playwright-cli close` / `close-all` 清旧 session
  - CDP 端口残留：`lsof -ti:${CDP_PORT} | xargs kill` 后重 attach
  - 始终带 case_id 命名 session：`playwright-cli -s=et-${CASE_ID} open ...` 防串

### 坑 2：snapshot 看得到元素但 click 报「element not visible」
- **现象**：snapshot 里明明有 `[ref=e5] button "Send"`，`playwright-cli click e5` 报 element not visible / not attached
- **成因**：元素在折叠区 / overflow hidden / 在 modal 后 / 虚拟列表未渲染 / 动画未结束
- **绕行**：
  - 先 `playwright-cli eval "el => el.getBoundingClientRect()" e5` 看 box 是否全 0
  - 显式 scroll：`playwright-cli eval "el => el.scrollIntoView()" e5`
  - 等动画：轮询 snapshot 直到该元素 box 非零（禁固定 sleep）
  - click 改用 `getByText('发送')` / `getByRole('button', { name: '...' })` 显式 locator（比 ref 更稳）

### 坑 3：LLM 调用后页面停在「思考中」很久
- **现象**：发了消息后「thinking...」spinner 持续显示，snapshot 看不到 assistant 回复
- **成因**：真 LLM 慢（反思类任务可达 30-60s+，token-by-token 流式长），不是 hang；harness 前台 sleep 被挡，长等待更要避免固定 sleep
- **绕行**：
  - 轮询 snapshot 直到目标元素出现（如 assistant message bubble）：`while ! playwright-cli --raw snapshot | grep -q 'assistant-message'; do sleep 2; done`
  - 长轮询用 Bash run_in_background + until-loop（harness 前台 sleep 被挡）
  - 设定有界等待（最长 60-90s，超时即标 small/blocking 交 orchestrator）
  - 若 case 是 LLM-heavy，preflight 用快模型而非重反思模型

### 坑 4：case 切换后状态串到上一个 case
- **现象**：跑了 case A 再跑 case B，B 看到 A 的会话历史 / 设置
- **成因**：后端 DATA_DIR env.sh 已隔离（每 case 不同 `$HOME/.${APP_NAME}_et_${CASE_ID}`）；但 browser session 用了 persistent profile 会跨 case
- **绕行**：
  - playwright-cli 默认 in-memory profile（每 `open` 即新 profile）— 默认安全
  - **禁用 `--persistent` / `--profile=`**（除非 case 显式要求保留登录态）
  - 跑完 `playwright-cli close` 关 session（env.sh 不会替你关 browser）
  - session 名也带 case_id：`playwright-cli -s=et-${CASE_ID}` 防互串

### 坑 5：packaged app / 系统 chrome 残留混淆
- **现象**：attach CDP 后看到的页面不对（不是测试 case 的），或 `requests` 看到无关流量
- **成因**：系统 packaged app 没退出 / Chrome 开着 / 其他 worktree 的 electron 在跑，占了 9222 段
- **绕行**：
  - env.sh start 前已 `lsof -ti:${PORT}` 清孤儿，但若 attach 时另一个进程抢了同端口，需重新确认
  - 显式指定：`playwright-cli attach --cdp=http://127.0.0.1:<本 case 的 cdp_port>`（不靠默认发现）
  - 检查：attach 后 `playwright-cli eval "location.href"` 应是 `http://127.0.0.1:${WEB_PORT}/...`；不是就是连错了

## 2. 启停协议（env.sh 调用契约）

| 角色 | 职责 | 命令 |
|------|------|------|
| orchestrator | env 生命周期 | `bash ${TESTS_DIR}/e2e/env.sh start ${CASE_ID} [--mode=headless\|electron]` / `stop ${CASE_ID}` |
| executor | 只 attach + 玩 | `playwright-cli open ${WEB_URL}` 或 `attach --cdp=${CDP_URL}` |

env.sh start 成功后 stdout 打印：
```
[env.sh] OK: case=${CASE_ID} mode=${MODE}
[env.sh]   API_URL=http://127.0.0.1:${API_PORT}
[env.sh]   WEB_URL=http://127.0.0.1:${WEB_PORT}
[env.sh]   CDP_URL=http://127.0.0.1:${CDP_PORT}   # 仅 electron 模式
```

**端口段约定（与 AT 隔离）**：
- ET API: 3800-3899
- ET WEB: 8900-8999
- ET CDP: 9222-9299（仅 electron 模式分配）

**每 case 独立 DATA_DIR**：`$HOME/.${APP_NAME}_et_${CASE_ID}`（env.sh stop 时删除）

## 3. case 执行流程（snapshot 导航 → action-key 优先定位 → 留证 4 件套）

```
1. Read case.md                 # 拿操作目标（自然语言）
2. Read app-guide §相关章节     # 拿 nav 路径（哪个 nav-* 进，怎么走）
3. playwright-cli open ${URL}    # 或 attach --cdp=${URL}
4. snapshot 导航主信息源（见下「snapshot 双层」）

# 一步一留证循环
5. 每个动作：
   a. 决定动作（click e5 / fill e3 "你好" / press Enter）
   b. 执行前 snapshot → 写 steps/NN-pre/snapshot.yml
   c. 执行动作
   d. 执行后 snapshot → 写 steps/NN-post/snapshot.yml
   e. screenshot --filename=steps/NN/screenshot.png
   f. eval "document.documentElement.outerHTML" > steps/NN/dom.html
   g. console > steps/NN/console.txt
   h. cat <<EOF > steps/NN/meta.json  # 写意图 + 观察 + 判定
6. 心证 → 汇报 verdict
7. playwright-cli close
```

### snapshot 双层（a11y 基线 + action-key 增强）

playwright snapshot = a11y tree，**故意丢所有 `data-*`**（含 `data-action-key`）。
action-key 住 DOM 但对 executor 不可见 → 引入 eval 增强：

- **a11y 基线 snapshot**（`playwright-cli snapshot`）：role/name/state/ref，全节点覆盖
- **action-key 增强 snapshot**（`bash ${TESTS_DIR}/e2e/snapshot-with-keys.sh`）：基线上对交互节点
  逐 ref `eval dataset.actionKey`，有值则在 `[ref=eN]` 后注入 `[action-key=X]`

```bash
# 增强脚本：session/cwd 自动复用（脚本继承 executor 的 cwd + 透传 -s=${SESSION}）
# 默认输出 stdout；--out=${PATH} 落盘（推荐落盘作留证 snapshot.yml）
bash ${TESTS_DIR}/e2e/snapshot-with-keys.sh --session=et-${CASE_ID} --out=steps/NN-post/snapshot.yml
# 留证的 snapshot.yml 推荐用增强版（带 action-key，给人/executor 复核都更清晰）
```

### 定位优先级（action-key 优先 → 文案 name 降级）

| 优先级 | 写法 | 何时用 |
|--------|------|--------|
| 1（首选） | `playwright-cli click e8`（ref）+ 在增强 snapshot 里验 `[action-key=X]` 锁定 | 增强后有 action-key 的节点（覆盖 nav / 主操作按钮） |
| 2（降级） | `playwright-cli click "getByText('发送')"` / `getByRole(...)` 文案 locator | 增强后仍无 action-key（未铺的节点 / 纯文本） |

**为何 action-key 优先**：改文案 / 切 i18n / 改 ref 编号都不会断（机器标识稳定）；
文案 locator 只在 action-key 缺位时兜底。case.md 无需标 action-key，executor 执行时
自动从增强 snapshot 里挑（零成本设计）。

**简化版**（步数多时合并 pre/post）：
```
每个动作直接落 steps/NN-${ACTION}/ 四件套：
  screenshot.png / dom.html / snapshot.yml（增强版，含 action-key）/ meta.json
（动作前后页面对比在 meta.json.my_observation 描述）
```

## 4. 留证规范（目录结构 + meta.json schema）

### 目录结构
```
${STATES_DIR}/v${VERSION}/verify/e2e/${CASE_ID}/
├── verdict.json              # 最终判定（case 级汇总）
└── steps/
    ├── 01-open-app/
    │   ├── screenshot.png
    │   ├── dom.html
    │   ├── snapshot.yml
    │   └── meta.json
    ├── 02-click-nav-target/
    │   └── ... (4 files)
    └── 03-send-message/
        └── ... (4 files)
```

### meta.json schema
```json
{
  "step": 1,
  "action": "open-app",
  "intent": "进入 app，主导航可见 + 落到默认页",
  "playwright_cmd": "playwright-cli goto http://127.0.0.1:8900",
  "console_errors": [],
  "console_warnings": [],
  "dom_anchors": ["nav-rail", "chat-page"],
  "my_observation": "页面加载成功，看到 nav-rail 7 个图标 + 默认进入 chat 板块，无 console error",
  "verdict": "pass"
}
```
字段说明：
- `dom_anchors`：snapshot 里确认存在的关键元素（role + 文案）
- `my_observation`：1-2 句话，你看到了什么（不是判 bug）
- `verdict`：本步判定 `pass` / `small` / `blocking`

### verdict.json（case 级汇总，跑完写）
```json
{
  "case_id": "sample-feature-flow",
  "verdict": "pass",
  "steps_total": 4,
  "steps_pass": 4,
  "steps_small": 0,
  "steps_blocking": 0,
  "summary": "成功发消息并收到 LLM 回复，主路径贯通",
  "key_artifacts": ["02-click-nav-target/screenshot.png", "04-verify-reply/snapshot.yml"]
}
```

## 5. 判定三态（blocking / small / pass）

| 态 | 定义 | 例子 |
|----|------|------|
| **pass** | 完全走通，无瑕疵 | 发消息→收到合理回复；切会话→上下文隔离生效 |
| **small** | 走通了但有瑕疵，不阻塞合并 | 文案微差、视觉小问题、偶发 console warning 但不影响主路径；留证供人复核 |
| **blocking** | 走不下去，阻塞性问题，退 coder | 关键元素找不到、click 报错、关键 API 500、LLM 一直空回、链路断、关键功能缺失 |

### 判定原则
- 走得通 + 主功能 OK = pass（不追求像素完美）
- 走得通 + 有瑕疵但不影响主路径 = small（留证供人判断）
- 走不下去 / 关键功能失效 = blocking（必附现象 + 你的归因，不猜 bug）
- **LLM 实际返回质量由人判**：你不判「这个回复好不好」，只判「有没有回复 + 回复链路通不通」

## 6. 依赖命令清单（详参 SKILL.md）

### executor 常用范式
```bash
# attach 到 env.sh 起的 browser
playwright-cli open http://127.0.0.1:${WEB_PORT}             # headless 模式
playwright-cli attach --cdp=http://127.0.0.1:${CDP_PORT}     # electron 模式

# 导航 + 看
playwright-cli snapshot                          # a11y 基线（role/name/state，丢 data-*）
playwright-cli --raw snapshot > path/snapshot.yml  # 留证用（基线）
# action-key 增强（推荐留证用，见 §3 snapshot 双层）：注入 [action-key=X] 到交互节点
bash ${TESTS_DIR}/e2e/snapshot-with-keys.sh --session=et-${CASE_ID} --out=path/snapshot.yml
playwright-cli find "Send"                       # 找元素
playwright-cli find --regex "/Sign (in|up)/i"

# 操作（定位优先级见 §3：action-key 优先 → 文案 name 降级；这里示范降级路径）
playwright-cli click "getByText('发送')"
playwright-cli fill "getByRole('textbox', { name: '输入消息' })" "你好" --submit
playwright-cli press Enter

# 留证
playwright-cli screenshot --filename=path/screenshot.png
playwright-cli eval "document.documentElement.outerHTML"  # → 重定向到 dom.html
playwright-cli console                          # 看 console error/warning

# 视觉辅助判定（按需，不强制）
python3 ${TESTS_DIR}/e2e/vision_check.py path/screenshot.png '[{"id":1,"check":"页面有 nav-rail"}]'
python3 ${TESTS_DIR}/e2e/vision_check.py compare path/impl.png path/design.png '[{"id":1,"dimension":"layout","check":"三栏布局"}]'

# 收尾
playwright-cli close
```

## 7. 不看截图原则的落地

**核心**：snapshot.yml 是你的主信息源，screenshot.png 只是留证给人看的。

- **禁**：`Read screenshot.png`（AGENTS.md 铁律）
- **禁**：调 `mcp__*__understand_image` 类 MCP
- **正解**：
  - 看页面状态用 `playwright-cli snapshot`（文本，可 grep）
  - 留证用 `playwright-cli screenshot --filename=...`（直接落盘，不 Read）
  - 真需要视觉判定（视觉保真 compare）按需 `python3 ${TESTS_DIR}/e2e/vision_check.py ...`，脚本吐 JSON，你读 JSON

**理由**：snapshot 是结构化的（ref / role / text），可机器对比；截图靠人眼 / vision model，慢且 flaky。功能验证一律走 snapshot + dom 断言，视觉保真才上 vision_check。

## 8. 与其他文档的关系
| 文档 | 定位 | 你怎么用 |
|------|------|---------|
| `.rocky/agents/e2e-test-executor.md` | agent 定义（我是谁/铁律） | 你的根定义 |
| 本文（executor-workflow.md） | 工作流详参（我怎么干） | 详参：环境坑/留证/判定/命令范式 |
| `app-e2e-real-run.md` | 用户层「能用」验收方法 | 互补（用户层 vs agent 层） |
| `SKILL.md` | playwright-cli 命令清单 | 命令速查 |
| `${SPECS_DIR}/ui/overall/00-app-guide.md` | app 导航底图 | 操作路径权威源 |
| `${TESTS_DIR}/e2e/${CASE_ID}/case.md` | 单 case 操作目标 | 你跑这个 |
| `${TESTS_DIR}/e2e/env.sh` | env 启停 | orchestrator 管，你不直接调 |
| `${TESTS_DIR}/e2e/vision_check.py` | 视觉辅助判定脚本 | 按需 Bash 调用 |
