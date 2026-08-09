# App 端到端真实跑（E2E real run）

> 何时用：验证某个功能/版本**「能用」**（深度使用可用）——不只单步 dom 断言绿，而是**照用户真实操作路径把功能端到端跑通**。这是 UT/AT/ET 之外的第 4 层验证，专挖「dev 自检全绿却真实不可用」的问题。
> 前置底图：**`specs/ui/overall/00-app-guide.md`**（app 布局手册）——照它的操作路径走。

## 核心判断：什么时候必须真实跑

UT/AT/ET 是「断言驱动的验证」（预设预期、机械判定）。但有一类问题它们都看不见：

- **接线类**：某依赖（如 engineDispatcher）在启动路径没注入，单测 mock 了它所以绿，真实跑却空转/卡死。
- **集成类**：跨层链路（前端→后端→LLM→落库）某处参数默认值错（如 `maxTokens` 缺省 0→LLM 400），单层测都不触发。
- **LLM 实际返回类**：真实模型在真实 prompt 下的行为（thinking-heavy 模型吞光 token、JSON 包 markdown、返回空）与 mock/录制假设不符。
- **交互/视觉类**：tab 不联动、i18n key 缺、弹层状态错乱——只有一路点过去才暴露。

**口诀**：dev 自测全绿 ≠ 能用。凡涉及「跨层链路 + LLM 实际调用 + 多步用户操作」的功能，验收前必须真实跑一次。

## 工作流

### 1. 起环境（test）

test 环境端口/数据目录与 dev/prod 隔离，真实跑用它：

```bash
# 后端 API_PORT=3700，前端 WEB_PORT=8787，数据目录 ~/.rocky_agent_test
# 用项目脚本起（或 tests/e2e 的 env_start.sh）
source ./test.env
# 起 server + web dev server（具体命令见 test.env 的 API_START_CMD / WEB_START_CMD）
```

> 若只验前端交互、不需真 LLM，可只起 web；但「能用」验收**必须真后端 + 真 LLM**（用户铁律：不 mock、真落库）。

### 2. 配 LLM provider（应用设置）

真实跑要调真模型。在 app 内 **应用设置（nav-settings-app）→ 模型** 配 provider，或直接改 `~/.rocky_agent_test/app_config`。

**坑（v0.0.187 实证）**：test 环境 default 模型可能是 thinking-heavy（如 deepseek-v4-pro），它在反思/推理任务会先「思考」吃掉大量 token（1000–7000）。若调用处 `maxTokens` 给小了（如 1024），思考阶段就耗光→文本空→功能静默失效。反思类任务 `maxTokens` 给 **16384+**。

### 3. 照 app-guide 操作路径走

打开 `specs/ui/overall/00-app-guide.md`，按目标功能的操作链路逐步执行。例（Academy 训练引擎）：

```bash
playwright-cli open http://localhost:8787
playwright-cli snapshot                      # 看初始页 + 拿 ref

# nav-rail 进 Academy
playwright-cli click "getByRole('button', { name: 'Academy' })"
playwright-cli snapshot                      # 看 Academy sidebar + main

# 照 app-guide §4.2 一步步走：建教室 → 建资源 → 发起训练 → 看迭代 → adopt
playwright-cli click "getByText('...')"      # 按 app-guide 路径的文案/位置
playwright-cli fill "getByRole('textbox', { name: '...' })" "..."
playwright-cli snapshot                      # 每步后看页面是否符合预期
```

**定位元素**：优先 snapshot（role + 可见文案 + ref）——`getByText('文案')` / `getByRole(...)` 稳定；文案来源 = 组件 spec「状态 / 交互」中的可见文案描述；也可用 `find "文案"` 或 snapshot ref `eN`。

**每步观察三件事**：
1. 页面是否符合预期（snapshot 看结构/文案/状态）
2. 有无 console 报错（`playwright-cli console`）
3. 链路是否通（如发起训练后任务是否真进入 running、分数是否真变化、candidate 是否真生成）

### 4. 遇使用问题即修（核心价值）

真实跑的意义就在于挖问题。发现问题后**三分归因**：

| 现象 | 归因 | 处置 |
|------|------|------|
| 元素不在 / 文案错 / tab 不联动 / i18n 缺 | **前端 bug** | 退 coder 改产品代码 |
| 请求 4xx/5xx / 数据没落库 / 任务卡死 / 链路断 | **后端 bug**（含接线/集成） | 退 coder 改后端（含启动注入/参数默认值） |
| LLM 400 / 返回空 / JSON 解析失败 / 思考吞 token | **LLM 调用参数 bug** | 退 coder 改 `maxTokens`/prompt/解析 |
| 元素定位不到 / playwright 自身报错 | **测试侧** | 改定位策略 / 查 element-attributes.md |

> 不要把真 bug 当「测试 flaky」绕过。v0.0.187 的 5 个 BUG（含 1 Critical engineDispatcher 未注入）全是真实跑挖出、UT/AT/ET 全绿却真实不可用的问题。

### 5. 验证闭环

「能用」= **端到端跑通 + 产生真实预期效果**。不只单步绿，要看：
- 链路首尾贯通（入口→最终效果，如训练后 student 版本真被 adopt、新 systemPrompt 真生效）。
- 真实数据落库（curl 后端 / 查 `~/.rocky_agent_test` 确认）。
- 多轮/边界（不只 happy path，试必错题、空数据、重复操作）。

## 注意事项

- **进程权限（TCC）**：系统原生能力（文件对话框、屏幕录制、辅助功能）须由主签名 `.app` 持有；裸 spawn 的 helper 子进程拿不到宿主 TCC 权限。验原生能力要装真 dmg，别指望 dev/dev-server。
- **不 mock**：真实跑 = 真服务 + 真 LLM + 真落库。不用 record/replay stub、不 mock 响应（那是 AT/ET 的事；真实跑要的就是真 LLM 的不可控行为）。
- **长任务/异步**：训练等长任务别用固定 sleep 等；`playwright-cli` 轮询 snapshot 直到目标状态出现（如任务状态变 done、分数出现）。harness 里前台 sleep 被挡，长等待用 `run_in_background` + until-loop。
- **费用**：真 LLM 调用花钱。真实跑聚焦「最小可验证路径」（app-guide 的主链路），不做无谓的全量回归。
- **清理**：跑完 `playwright-cli close` + 关 test 环境 server，别留孤儿进程。
- **不替代 AT/ET**：真实跑是验收层（验「能用」），AT/ET 仍是回归门禁（验「没退化」）。两者互补，不互替。

## 与 app-guide 的关系

`specs/ui/overall/00-app-guide.md` 是**导航底图**（入口/路径/链路/布局），本 reference 是**执行方法**（怎么用 playwright-cli 把那条路径走一遍、遇问题怎么修）。两者配套：

- app-guide 告诉你「功能在哪、怎么走」；
- 本 reference 告诉你「怎么验证它真能走通、走不通怎么归因修」。

每个版本的 doc-sync 更新 app-guide 后，真实跑就照最新 app-guide 走——app-guide 准 → 真实跑定位准。
