# v0329-door-persist — 329 门模型持久化 + 功能回归

> 一次性 case（v0.0.329，非入库）：验证 `pv-door-<sid>` 持久化（刷新恢复 + 旧 `pv-collapsed` 迁移）+ 门最左编辑保存 + 门最右 chat 发消息 + 回 center chat 消息完整恢复。
> PRD 路径源：`specs/prd/version_logs/v0.0.329-region23-door.md` §3.5/§7（UC-7/8/9）+ §12 验收 9/10/11 + §13 注意事项。

## Use Case
门状态 per-session localStorage `pv-door-<sid>`（center/left/right）刷新/重进恢复；旧 `pv-collapsed-<sid>='1'` 迁移为 door=right（用户无感）；门最左（遮 chat）时预览区编辑/保存正常；门最右（遮 preview）时 chat 消息流/输入/发送正常；回 center 后 chat 消息完整恢复不丢。

## 前置条件
- `bash tests/e2e/env.sh start v0329-door-persist --mode=headless`
- Playground 新建会话 → 发一条消息等 LLM 回复完成 → ws-panel 打开一个文本文件进预览区（消息 DOM + 预览并存）。

## 操作目标（编号步骤）

1. **建立消息流基线**：发一条简单消息（如「你好」）→ 等 LLM 回复完成 → 记录消息 DOM 条数 N（`[data-testid^="msg"]` 或 message-stream 内气泡计数）。
2. **center → left（遮 chat）**：点 `pv-door-left` → 断言 chat 区不可见（消息 DOM 消失、输入框不可见）。
3. **left 态编辑保存（UC-7 / 验收10）**：预览 tab 点编辑（`pv-float-edit`）→ 修改内容 → 点保存（`pv-float-save`）→ 断言保存成功（无 error 条，回 view 态）。
4. **left → center（消息恢复）**：点 ▶（`pv-door-center`）→ 断言 chat 消息完整恢复：条数 = N、step1 的内容在（不丢消息，PRD §13「恢复居中后可见」）。
5. **center → right（遮 preview）**：点 `pv-door-right` → 断言 preview 不可见（无 pv-panel）、chat 输入框可见可输入。
6. **right 态发消息（验收10）**：输入区再发一条消息 → LLM 回复完成 → 断言发送/回复正常（消息条数 N+2）。
7. **right → center（preview 恢复）**：点 ◀（`pv-collapse-expand`）→ 断言 preview 回位：文件 tab 还在、内容在。
8. **持久化刷新恢复（UC-9 / 验收9）**：门滑到 left → `playwright-cli reload` → 重新导航进同一会话 → 断言恢复 left 态（rail 粗线在门框左缘 + ▶）；再点 ▶ 回 center 验证可交互。
9. **旧 pv-collapsed 迁移（§3.5/§10）**：`eval` 手动设 `localStorage['pv-collapsed-<sid>']='1'` 并删除 `pv-door-<sid>` → reload → 断言恢复 door=right 态（rail 粗线贴门框右缘 + ◀ 贴左）。
10. **坏值兜底（tech change_log D1）**：`eval` 设 `pv-door-<sid>='bogus'` → reload → 断言回 center（不 crash、双把手）。

## 验收口径（executor 自由心证）
- **pass**：1-10 全走通——消息不丢、编辑保存正常、发消息正常、刷新恢复门态、旧 key 迁移为 right、坏值兜底 center。
- **small**：主链路通但有瑕疵（如视觉小偏差、偶发需多等一拍）。
- **blocking**：回 center 消息丢失 / 编辑保存失败 / right 态发消息失败 / 刷新不恢复 / 迁移不生效 / 坏值 crash。

## 依赖
- specs/prd/version_logs/v0.0.329-region23-door.md §3.5/§7/§12/§13
- specs/tech/version_logs/v0.0.329/change_log.md（D1 迁移 + 条件不渲染决策）
- specs/ui/components/chat-page/section-preview-area.md §5.6/§5.7
- specs/ui/overall/00-app-guide.md §3.1（Playground 导航）
