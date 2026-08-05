# heartbeat-config（squad 级心跳配置 section — interval + activeWindows + scope）

> 文件: app/web/src/components/studio-page/section-heartbeat-config.tsx

## 职责
为**整个 squad** 配置统一心跳调度参数（间隔 + 多工作时间段 + 范围）。配 → scheduler 按时段内每 interval 到点整队一次，按范围对符合条件成员逐个唤醒跑自主工作。**一队一份配置，不再 per-member**。
边界：
- 配 3 组参数：**interval**（间隔选择）/ **activeWindows**（多工作时间段增删）/ **scope**（范围 all/whitelist + 白名单勾选）。
- 不配 enableHeartBeat（总开关，见 `squad-autonomy-toggle.md`——总开关关时本 section 收起/禁用）/ budget（`budget-meter.md`）。
- activeWindows 跟 `squad.timezone`（不在本组件改 tz，去管理 tab）。

## Props
- squadId: string
- enableHeartBeat: boolean;                 // 总开关（关时本 section 禁用/收起提示）
- heartbeatConfig: SquadHeartbeatConfig | null;  // 当前值：{ interval, activeWindo...
- members: Member[];                        // scope=whitelist 时勾选用（deployed 成员列表）
- timezone: string;                         // 显示用：activeWindows 跟 squad.timezone
- onSave: (patch: PatchSquadBody) => Promise<void>;  // 走 PATCH /squad/:id { he...

## 状态 / 交互
- **interval**：单选（禁原生 `<select>`，用 chip/segmented，`_conventions §10`）——5 / 15 / 30 / 60 分钟四选一，默认 15。
- **activeWindows 多段列表**：每段两个 `<input type="time">`（start/end，24h HH:mm，start < end 同日）+ 删除按钮；「添加工作时间段」按钮追加空段。**约束**：段间不重叠、单段不跨 0 点——前端可先提示，最终由后端 400 校验兜底。**空列表 = 全天**（提示「未设时段 = 全天可调度」）。
- **scope**：`toggle-switch`（off=all 全员 / on=whitelist 白名单）。on 时展开成员勾选列表（`members` 中 deployed 成员，勾选进 `memberIds`）——提示「仅唤醒勾选成员，后续新增成员不自动纳入」。
- **清空/重置默认**：调 `onSave({ heartbeatConfig: null })` → 回退默认（interval=15 / 全天 / all）。
- **总开关关提示**：`enableHeartBeat=false` 时 section 显示「自主性总开关已关，配置保存但暂不生效」（交叉引用 squad-autonomy-toggle，非阻断）。
- **反映当前值**：进入 section 回填 heartbeatConfig（null → 默认）；保存成功基线重置 → dirty 消失。

## 视觉基线
> 本版本无设计师权威稿（req 附方向 HTML 原型，orchestrator 看着办，复杂处可先出设计）。按既有 autowork-tab / studio 卡片视觉对齐。
- 字段 label ；activeWindows 段用 flex 行（start — end — 删除）。
- interval 单选用 segmented chip（选中 accent 描边）；scope switch 用 toggle-switch primitive。
- `<input type="time">` 浏览器原生 OK（非单选 enum，不触发 §10 禁 select）。

## 复用关系
- **被组合**：`component-autowork-tab`（与 squad-autonomy-toggle + budget-meter + auto
- **交叉引用**：`component-squad-autonomy-toggle`（总开关关时本 section 显示 disabled 提示）；`sec
