# v0.0.218 change_plan — snapshot action-key 暴露（eval 增强）

## 背景 + 方案（详见 req）
v0.0.211 铺 data-action-key（DOM 157 处）但 playwright snapshot = a11y tree 不含 data-*，executor 主信息源 snapshot.yml 看不到 → action-key 对 ET 死代码。a11y 口子（aria-label/title）搭不了便车（污染无障碍）。**方案 = eval 增强**：snapshot 后逐 ref eval 读 data-action-key 注入 snapshot，executor 自动可见。不改 playwright-cli 二进制。

## 变更（method 级 8 列）
| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响 |
|---|---|---|---|---|---|---|---|
| enhance 脚本 | tests/e2e/snapshot-with-keys.sh | main | A | `playwright-cli snapshot --filename` 存盘 → 正则提 `[ref=e\d+]` → 逐 ref `playwright-cli eval "el=>el.dataset.actionKey\|\|''"` → 有值则在该行注入 `[action-key=X]` → 输出增强 snapshot | 复用 executor 的 playwright-cli session（**先 spike 验证**：默认复用最近 open / 或 `-s=<session>` 传参，脚本接受可选 session 参数）；容忍无 key 节点（不注入）；eval timeout 10s/ref；只对可交互节点（button/link/[role]）eval 优化性能 | element-attributes.md（eval `<ref>` 读属性）；SKILL.md session-management | 新文件 |
| executor 约定 | .claude/skills/playwright-cli/references/executor-workflow.md | §3 case 执行流程 snapshot 段 | M | snapshot 后跑 `snapshot-with-keys.sh` 拿增强 snapshot（带 action-key）；定位优先 action-key（`[action-key=X]`），无则降级文案 name | 不改二进制；action-key 留 data-* 不污染 a11y；未铺节点降级 name 不破坏旧用法 | req v0.0.218 | +若干行 |
| skill 版本对齐 | .claude/skills/playwright-cli/{SKILL.md, references/element-attributes.md, references/test-generation.md} | — | M | `playwright-cli install --skills` 更新（消除版本警告，已执行） | 工具自动更新，复核无破坏性 | — | 3 文件已 M |

## 验证（T2）
跑 2-3 简单已有 ET case（academy 建教室 + chat 发消息），确认增强后 dump 的 snapshot.yml 里 `[action-key=...]` 出现 + executor 能用 action-key 定位（不依赖文案）。

## 非目标
- 不改 playwright-cli 二进制
- 不改前端 action-key 铺设（data-* 保留）
- 不写框架 UT（memory no-tests-for-test-framework，靠跑 case 验证）
- 不强制所有节点有 action-key（未铺的降级 name）

## 风险 + 缓解
- **session 复用**：snapshot-with-keys.sh 的 `playwright-cli eval` 要连 executor session。coder **先 spike 验证**（默认 session 复用 / `-s` 传参）；若不行向 orchestrator 汇报换方案（executor 内联 eval，不写脚本）
- **性能**：逐 ref eval 慢。snapshot 几十 ref × ~0.2s = ~10s，可接受（ET 非高频）；只 eval 可交互节点优化
