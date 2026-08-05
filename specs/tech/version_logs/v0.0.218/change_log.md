# v0.0.218 change_log — snapshot action-key 暴露（eval 增强）

## 版本概要

v0.0.211 铺的 `data-action-key`（DOM 157 处）住 DOM 但 playwright snapshot = a11y tree 丢 data-*，executor 主信息源 snapshot.yml 看不到 → action-key 对 ET 是死代码。a11y 口子（aria-label→name / title→tooltip）承载机器标识会污染无障碍。**方案 = eval 增强**：snapshot 后逐交互节点 eval 读 `dataset.actionKey` 注入 `[action-key=X]` 到 snapshot 文本，executor 自动可见。不改二进制不污染 a11y。

**性质**：纯测试基建（无用户可感知变化）→ PRD 跳过（用户裁决 2026-07-14 PRD 参与边界）。

## 交付

| 模块 | 文件 | 说明 |
|---|---|---|
| enhance 脚本 | `tests/e2e/snapshot-with-keys.sh`（新建，142 行）| snapshot 后逐交互节点 eval 注入 `[action-key=X]`，三层校验防 `--raw eval` stdout 污染；session per-cwd 复用 + `--session=` 透传；`--out=`/`--depth=`/`--timeout-eval=` 参数 |
| executor 约定 | `.claude/skills/playwright-cli/references/executor-workflow.md` §3/§6 | §3 加 snapshot 双层（a11y 基线 + action-key 增强）+ 定位优先级表（action-key > ref > 文案 name 降级）；§6 加增强命令范式 |
| skill 版本对齐 | `.claude/skills/playwright-cli/{SKILL.md, references/element-attributes.md, references/test-generation.md}` | `playwright-cli install --skills` 更新，消除版本警告（3 文件 M，复核无破坏性） |

## 4 偏离（实现细节增强，未触核心约束）

coder T1 实现 4 处偏离 change_plan 的具体行，全裁决合理（code-review CONDITIONAL PASS 认可）：

1. **garbage 三层校验**（防 `--raw eval` 错误时 exit=0 + stdout 污染）：change_plan 只写「eval dataset.actionKey」，实际 `playwright-cli --raw eval` 错误时（ref 不存在等）exit=0 + 把 `### Error\n...` 写到 stdout，不能靠退出码判。脚本加三层校验：单行（不含 `\n`）+ JSON 字符串字面量 `^"...$` + action-key 命名规范 `[a-z0-9][a-z0-9.-]*`，否则透传原行不注入（防 `[action-key=### Error]`）。
2. **bash while-read 末行坑**：`while read` 默认丢无尾换行的末行，须 `\|\| [ -n "$line" ]`；`wc -l` 数换行符不数行（无尾换行的单行算 0），改用 `case` 测 `\n`。
3. **恢复 install --skills 误删的 `app-e2e-real-run.md` 索引行**：`install --skills` 执行时误删 `SKILL.md` 里 v0.0.197 项目特定的 `app-e2e-real-run.md` references 索引行（上游新版本骨架不含此行），coder 发现后手动恢复（保 v0.0.197 项目特定配置不丢）。
4. **§3 扩展为 snapshot 双层概念 + 定位优先级表**：change_plan 只说「snapshot 后跑增强脚本」，coder 实际在 executor-workflow §3 扩展为完整「snapshot 双层（a11y 基线 + action-key 增强）+ 定位优先级表（action-key > ref > 文案 name 降级）」概念段，把 action-key 优先的原则写成表格让 executor 一目了然。

**session 复用机制 spike 确认**：spike 实测确认 subprocess 可复用 session —— playwright-cli session 是 per-cwd（metadata 存 `<cwd>/.playwright-cli/`），脚本继承 executor cwd → 自然复用；executor 若用 `-s=et-<cid>` 命名 session，脚本透传 `--session=<name>`。不在同一 cwd / 不传 session → snapshot 报 "browser not open"。

## 验证结论（T2）

- **核心 dump 验证通过**：增强 snapshot 注入 action-key 正确——首页 9 个交互节点（nav 7 + 新建会话/对话 2）全注入正确 action-key；academy 页 9 个含 `academy.classroom.create`（验证跨板块铺设可工作）。
- **action-key click 定位可用**：增强 snapshot 里 `[action-key=X]` 可作 executor 锁定锚点。
- **性能**：9 个交互节点全 eval ~9s（15 个交互 ref × ~0.5s），可接受（ET 非高频）。
- 用户选择「dump 验证通过即进合并，不跑完整 LLM case」（简化流程，节省 token）。

## 非目标（未做）

- 不改 playwright-cli 二进制
- 不改前端 action-key 铺设（data-* 保留）
- 不写框架 UT（memory `no-tests-for-test-framework`，靠跑 case 验证）
- 不强制所有节点有 action-key（未铺的降级 name 不破坏旧用法）

## 关联

- change_plan（method 级契约）：`specs/tech/version_logs/v0.0.218/change_plan.md`
- 需求：`reqs/[working] v0.0.218.snapshot-action-key/req.md`
- spec 同步：`specs/tech/testing/{index.md, et-framework.md, log.md}` + `specs/ui/components/_conventions.md §12.5`
