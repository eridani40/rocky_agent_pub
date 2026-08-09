# browser-attach-lifecycle — browser 工具 attach 模式生命周期（launch→操作→close + 失活自愈）

> v0.0.266 工具链 ET case（attach 生命周期统一：attach 走 launch → 操作复用实例 → close；异常自愈）。纯自然语言，零断言零录制；executor 经聊天驱动 agent 调 browser 工具，**验收看工具调用结果**（LLM 返回的工具结果文本）。
> API 权威：`specs/api/overall/08-web-tools.md` §4（browser 工具 schema / 生命周期语义 / 错误表）。

## Use Case
作为 Rocky 的用户，我在 Playground 聊天里让 agent 用 browser 工具 **attach 模式**操作我自己已开的 Chrome（`--remote-debugging-port=9222`）：`launch` 建立连接 → `navigate` / `snapshot` 操作 → `close` 断开（**我的 Chrome 窗口仍在，不被杀**）。再次 `launch` 后，操作中**我手动杀掉 Chrome** → 下一步操作应**自愈提示**（连接已断开 / 请重新 launch，isError 非卡死）→ 重新 `launch` 恢复正常。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- LLM provider 可用（minimax 优先；429 则按 skipped 口径汇报，不算 fail）。
- **executor 手动起 Chrome 并开 remote debugging**：`open -a "Google Chrome" --args --remote-debugging-port=9222`（或等效命令），确认 `http://127.0.0.1:9222/json/version` 可访问。
- **attach 门禁开启**：连接器 → 浏览器 → attach switch 打开（v0.0.46 门禁；未开则 agent 调用会返回 `browser attach 未启用`，executor 先开开关）。
- 聊天驱动 agent 调 browser 工具（attach 需 HITL 审批，executor 放行）。

## 操作目标（编号步骤）

1. **起环境 + 起用户 Chrome**：按前置条件起好 env 与 `--remote-debugging-port=9222` 的 Chrome。
2. **进入 Playground 建会话**：照 `specs/ui/overall/00-app-guide.md` §3.1 进 Playground，新建/选一个会话。
3. **让 agent launch attach**：聊天里发指令——「用 browser 工具 attach 模式 launch，cdpUrl 用 127.0.0.1:9222」（或让 agent 自行 attach 默认 9222）。等待工具调用完成（HITL 审批放行）。
4. **验收 launch 成功**：工具结果返回 `launched attach`（或幂等 `reuse`），无错误。
5. **让 agent navigate**：指令——「browser navigate 到 https://example.com」（attach 会话上执行）。
6. **让 agent snapshot**：指令——「browser snapshot」。验收：返回当前页面结构/标题（如 example.com 标题），连接仍有效。
7. **让 agent close**：指令——「browser close（attach 模式）」。验收：返回 `closed`（attach 语义 = 断 CDP）。
8. **验收 close 后用户 Chrome 仍在**：executor 检查自己的 Chrome 窗口/进程**仍存在**（attach close 不杀用户 chrome；若被杀 = 严重 bug）。
9. **再次 launch attach**：让 agent 再 `launch attach`（连回 9222），成功后可操作。
10. **操作中 executor 手动杀 Chrome**：让 agent 执行一步操作（如 navigate/snapshot）期间或之后，executor **手动杀掉 Chrome**（kill 进程或关窗口，CDP 断）。
11. **下一步操作验收失活自愈**：让 agent 再执行一步操作（如 snapshot）→ 验收：返回 **isError 提示**（「连接已断开，请重新 launch」类文案，或等效失活检测提示），**不卡死、不无限等待**。
12. **重新 launch 恢复**：让 agent 重新 `launch attach` → 验收：连接恢复，再 `navigate`/`snapshot` 成功。

## 验收口径（executor 自由心证）
- **pass**：attach 生命周期全链路贯通——launch → navigate/snapshot → close（**用户 Chrome 仍在**）→ 再 launch → 手动杀 Chrome 后下一步操作**失活自愈提示**（isError，不卡死）→ 重新 launch 恢复正常。
- **small**：主链路通但有小瑕疵（失活提示文案措辞略异、close 后需重新 launch 才能复用实例、某步需重试一次，不影响生命周期语义）。
- **blocking**：launch attach 失败（无法连 9222）/ close **杀掉用户 Chrome** / 手动杀 Chrome 后下一步操作**卡死或无限等待**（无失活检测）/ 失活后重新 launch 无法恢复 / 每次操作都重新隐式连而非复用实例（未走 InstanceManager）。
- **skipped**：attach 门禁无法开启 / 无法起带 remote debugging 的 Chrome（环境问题非产品 bug，如实记 reason）。

## 依赖
- specs/api/overall/08-web-tools.md §4（browser 工具 schema：mode=attach / launch·close 生命周期 / 错误表 `no_browser_instance` / attach 门禁）
- specs/tech/agent/tools/[P1]browser_instance_manager.md（InstanceManager 生命周期 + 失活自愈）
- specs/tech/agent/tools/[P1]browser_tool.md（attach 机制 / ChromeMcpDriver）
