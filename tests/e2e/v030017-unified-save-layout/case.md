# ET case: v0.0.317 配置管理保存交互全局统一

> case_id: v030017-unified-save-layout
> 目标: 截图所有管理页面，验证 SaveBar 位置/风格/逻辑统一

## 前置

- dev app 已启动（dev.env, APP_NAME=rocky_agent_dev, API_PORT=3710, WEB_PORT=8788）
- 用 playwright-cli 截图，每步留证到 verify/e2e/v030017-unified-save-layout/steps/

## 步骤

### 1. App Config — 通用 tab（语言保存才切）
1. 打开 App Config 设置页
2. 截图 general tab（语言卡片应该有 SaveBar？未改动时应该没有）
3. 点选另一种语言 → 截图（SaveBar 应出现，UI 不应切换语言）
4. 点保存 → 截图（UI 切换 + SaveBar 消失）
5. 再选回原语言 → 点取消 → 截图（SaveBar 消失，语言未切）

### 2. App Config — 技术配置 tab（工具区 toggle 进 dirty）
1. 切到 tools tab
2. 截图（无改动时无 SaveBar）
3. 翻转任意工具 toggle → 截图（SaveBar 应出现）
4. 点取消 → 截图（toggle 回原值，SaveBar 消失）

### 3. App Config — 可观测性 tab（list toggle + logs toggle 进 dirty）
1. 切到 observability tab
2. 截图 list 页（无改动时无 SaveBar）
3. 翻转 list 页某条 observability 的 enabled toggle → 截图（SaveBar 应出现）
4. 翻转 logs group 某个日志 toggle → 截图（SaveBar 应保持出现）
5. 点取消 → 截图（所有 toggle 回原值，SaveBar 消失）
6. 进 detail 编辑 → 翻转 header toggle → 截图（SaveBar 应出现）
7. 点取消退出 detail → 截图

### 4. Studio — 团队管理 ManageTab（SaveBar 面板级）
1. 打开 Studio → 团队管理
2. 切到管理 tab → 截图（无改动时无 SaveBar）
3. 改某个字段 → 截图（SaveBar 应出现在面板底部 sticky）
4. 点保存 → 截图（SaveBar 消失，dirty 清零）
5. 再改 → 切 tab → 截图（应弹确认 modal）

### 5. Studio — 自动工作 AutoworkTab
1. 切到自动工作 tab → 截图
2. 改某个字段 → 截图（SaveBar 应出现）
3. 点取消 → 截图（SaveBar 消失）

### 6. Studio — Member 编辑面板
1. 点某个 member 进编辑 → 截图
2. 改字段 → 截图（SaveBar 应出现在底部 sticky）
3. 点保存 → 截图（SaveBar 消失）

### 7. 连接器 — 供应商详情（detail SaveBar）
1. 打开 Providers 页
2. 点某供应商进编辑 → 截图
3. 改字段 → 截图（detail SaveBar 应出现）
4. 点取消 → 截图

### 8. 连接器 — 渠道表单（detail SaveBar）
1. 打开 Channels 页
2. 点编辑某渠道 → 截图
3. 改字段 → 截图（detail SaveBar 应出现）

## 判定标准

- **pass**: 所有页面的 SaveBar 位置（底部 sticky）、风格（dirty 文字 + 取消 + 保存）、逻辑（进 dirty → 点保存才生效）完全统一
- **small**: 走通但有轻微视觉差异（间距/颜色微调），不阻塞合并
- **blocking**: 有页面 SaveBar 不出现 / 位置不对 / 即时生效未改 / dirty 不清零
