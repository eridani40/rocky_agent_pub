# ET case: 工作区搜索框全流程（输入 → 结果 → 开 tab → 清空恢复）

> case_id: file_preview_ec6
> 来源: PRD §6 EC-6（UC-6 覆盖）+ test-plan §4 EC-6
> 前置: v0.0.320 搜索功能已编码完成（Task 1 后端 search 端点 + Task 2 前端搜索框），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页
- workspace 目录内有可搜索文件（如 `src/utils/helper.ts`、`notes.md`、`config.json` 等；建议文件名含独特关键词如 `helper`，可临时创建）

## 操作目标

1. 工作区面板文件树上方找到搜索框（placeholder「搜索文件…」，位于 TabBar 与 PathBar 之间）
2. 输入关键词（如 `helper`）→ 防抖 300ms 后展示结果：
   - 文件名匹配（前端过滤 + 后端补全合并去重）→ 显示匹配文件全路径（如 `src/utils/helper.ts`）
   - 文件夹名匹配 → 显示匹配文件夹全路径（其下层内容一并展示）
3. 点搜索结果文件（如 `src/utils/helper.ts`）→ 预览区开 tab 显示内容
4. 清空搜索框（点 × 或删空输入）→ 恢复原文件树（展开态保留）
5. 断言：
   - 输入关键词 → 结果列表出现（含目标文件全路径）
   - 点结果 → 预览区开 tab
   - 清空 → 原树恢复（文件树回到搜索前状态）
6. 截图留证：搜索框输入态 + 结果列表 + 点结果开 tab + 清空恢复

## 判定
- pass: 搜索输入 → 结果展示（文件+文件夹匹配）→ 点结果开 tab → 清空恢复原树，全流程正常
- small: 全流程走通但结果排序/展示有小瑕疵
- blocking: 搜索框不出现 / 输入无结果 / 点结果不开 tab / 清空不恢复

## 备注
- 搜索实现：前端过滤已加载树（文件名 substring 大小写不敏感）+ 后端补全 `GET /session/:id/workspace/search?q=`（递归全量，ignore node_modules/.git，上限 200 条截断）（PRD §2.5 D8/D10）
- 空输入不请求后端（展示原树）
- 结果超 200 条 → 提示「结果过多，请细化关键词」（边界，可选验证）
- 搜索态与树态互斥（搜索时渲染结果列表）
