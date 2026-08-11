# ET case: 编辑 → 不保存切 tab → dirty 确认 modal 三选项

> case_id: file_preview_ec3
> 来源: PRD §6 EC-3（UC-4 覆盖）+ test-plan §4 EC-3
> 前置: v0.0.320 文件预览区功能已编码完成（Task 2/3），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页
- workspace 目录内至少 2 个文本文件（如 `a.md`、`b.md`）

## 操作目标

1. 工作区点 `a.md` → 预览区开 tab（view 模式）
2. 点「编辑」→ 进入 edit 模式（textarea 显示内容 + 保存/取消按钮）
3. 修改内容 → dirty ● 出现（tab 标题旁圆点标记）
4. **不保存**点另一个 tab（`b.md`）→ 弹 dirty 确认 modal：
   - 标题「文件「a.md」有未保存的修改」
   - 三选项：「保存并切换」「放弃修改」「取消」（PRD §3.2）
5. 三路验证：
   - 点「保存并切换」→ 保存成功（toast「已保存」）→ 切到 `b.md` tab，`a.md` dirty 清除
   - 点「放弃修改」→ 丢弃 draft → 切到目标 tab
   - 点「取消」→ 留在当前 tab，draft 保留（切回后内容还在）
   - ⚠️ 三路需分别重开 tab 独立验证（每次操作前恢复初始态）
6. 截图留证：edit 态 + dirty ● + modal 三选项 + 三路结果各一张

## 判定
- pass: dirty modal 出现且三选项（保存并切换/放弃/取消）行为全部正确
- small: modal 出现但某一路行为有小瑕疵（非数据丢失）
- blocking: 不保存切 tab 不弹 modal / 直接丢 draft / 保存并切换失败 / 放弃后内容未丢

## 备注
- dirty 守卫拦截所有切/关 tab（D4）：`edit(dirty=true) ──切 tab/关 tab──▶ 弹确认 modal`
- edit(dirty=false) 切 tab 直接放行（无 modal）
- 保存成功 → toast「已保存」+ 回 view + dirty=false（EC-9 单独覆盖闭环）
