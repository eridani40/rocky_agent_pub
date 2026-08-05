# hero-screenshot — README hero 物料采集（非冒烟，纯截图）

> 本 case 是**物料采集**（为 README 采集代表性 UI 画面），非功能冒烟测试，**不进版本门禁**。
> executor 每步照常留 screenshot + dom.html + snapshot.yml + meta.json 四件套，orchestrator 从 snapshot.yml 读画面（不读截图）。
>
> **隐私要求（MANDATORY）**：env.sh 起的是隔离空 DATA_DIR（`~/.rocky_agent_et_hero-screenshot`），界面应为空状态。**任何画面若出现 `/Users/...` 真实路径、真实文件名、真实会话内容、真实 API key → 立即停止该步、不截图、标注 blocking**，继续下一步。

## Use Case
为 Rocky Agent 的 README 采集 hero 图——展示产品代表性 UI（暖色系、布局、核心板块入口），让访客一眼看到产品样子。不追求像素完美，追求"干净、无隐私、能体现产品形态"。

## 前置条件
- `tests/e2e/env.sh start hero-screenshot --mode=headless` 已起（隔离 DATA_DIR，空状态）
- **不需要真调 LLM**（只采界面，不发消息、不跑 agent）

## 操作目标（编号步骤）

每步：用 playwright-cli 导航到画面 → 先 `snapshot` 检查文本无隐私 → 再 `screenshot --filename=...` 留证。四件套落 `states/<ver>/verify/e2e/hero-screenshot/steps/NN-<action>/`。

1. **Playground（chat 主界面）**：照 `specs/ui/overall/00-app-guide.md` §3.1 从 nav-rail 点 Playground，落到 chat 页。空 chat / 占位 / onboarding 引导均可——体现主聊天界面即可。截图。
2. **Squad Studio**：照 app-guide 从 nav-rail 进 Squad。空 squad / 空 member 列表均可。截图。
3. **Settings → Providers**：照 app-guide 进设置 → Providers 页。截图（provider 配置界面，**必须无真实 key 明文**——key 字段应是空的/掩码）。
4. **Skills（技能市场）**：nav-rail 点 Skills，截图技能市场界面。
5. **（可选）Academy 或其它板块**：若入口可达，截图。

## 隐私检查（executor 每步截图前必做）
- `playwright-cli snapshot` 读画面文本树，检查是否含 `/Users/`、真实文件名、真实对话内容、`sk-` 开头 key。
- 命中任一 → **不截该画面**，verdict 标 blocking 并附 snapshot 证据，继续下一步。
- 优先空状态 / 设置页（天然无个人数据）。

## 验收口径（executor 自由心证）
- **pass**：至少采到 Playground + Settings 两张干净画面（无隐私泄露），可供 README 使用。
- **small**：采到了但某板块入口找不到 / 视觉小瑕疵（不影响主物料采集）。
- **blocking**：环境起不来 / nav-rail 都进不去 / 所有候选画面都含隐私无法采。

## 依赖
- `specs/ui/overall/00-app-guide.md`（各板块入口路径）
- `tests/e2e/env.sh`（headless 隔离环境）
