# ET case: tab 关闭 + 焦点切换 + 空态（关闭激活 tab 左移；关闭最后 dirty tab 守卫）

> case_id: file_preview_ec12
> 来源: PRD §6 EC-12（UC-9 覆盖）+ test-plan §4 EC-12
> 前置: v0.0.320 预览区 tab 状态机已编码完成（Task 2 D4/D5），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页
- workspace 目录内至少 3 个文本文件（如 `a.md`、`b.md`、`c.md`）

## 操作目标

**Part A：关闭激活 tab → 焦点左移**
1. 依次点 `a.md`、`b.md`、`c.md` → 预览区开 3 个 tab（tab 序 A-B-C，C 激活）
2. 点 C 的 × → 关闭 C → 断言焦点切到 B（左优先）
3. 点 B 的 × → 关闭 B → 断言焦点切到 A
4. 断言 tab 序与焦点：关闭激活 tab 后焦点左移（VS Code 习惯）

**Part B：关闭最后 dirty tab → 守卫 + 空态**
5. 点 A 的「编辑」→ 修改内容 → dirty ● 出现（A 为当前唯一 tab，且 dirty）
6. 点 A 的 × → 断言弹 dirty 守卫 modal（保存并切换/放弃修改/取消，不直接丢）
7. 点「放弃修改」→ A 关闭 → 预览区空态占位出现（「打开文件以预览」muted 文案）
8. 断言空态：预览区本身还在（栏不消失），显示空态占位
9. 截图留证：3 tab 态 + 关 C 后焦点 B + 关 B 后焦点 A + dirty A + 守卫 modal + 放弃后空态

## 判定
- pass: 关闭激活 tab 焦点左移正确；关闭最后 dirty tab 弹守卫；放弃后空态占位正常
- small: 焦点切换/守卫正常但空态样式有小瑕疵
- blocking: 关闭 tab 焦点不切换（无焦点/焦点错位）/ dirty tab 直接关闭不弹守卫 / 放弃后预览区消失或崩溃

## 备注
- tab 关闭（PRD §2.2 D4/D5）：
  - 每个 tab 卡片右侧有 × 关闭按钮
  - dirty tab 关闭 → dirty 守卫（保存/取消/放弃，不能直接丢）
  - 关闭激活 tab → 焦点切相邻（**左优先**）；无相邻（仅剩一个）→ 空态
  - 最后一个 tab 关闭 → 空态占位（预览区本身还在，不自动消失）
- dirty 守卫 modal 三选项：「保存并切换」「放弃修改」「取消」（PRD §3.2）
- 本 case Part B 覆盖「放弃修改」路；「保存并切换」「取消」路由 EC-3 已覆盖
