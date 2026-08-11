# squad-autonomy-toggle（自主性总开关 — enableHeartBeat killswitch）

> 文件: app/web/src/components/studio-page/component-squad-autonomy-toggle.tsx

## 职责
squad 级**自主性 killswitch**：开/关 `squad.enableHeartBeat`。开 → scheduler 心跳调度生效（所有 deployed member 心跳按各自 interval 唤醒）；关 → scheduler 下一 tick（≤1s）读到 false 即整体跳过心跳触发（群聊 reactive 不受影响——reactive 不走 scheduler gate）。

> **[v0.0.316] 受控化**：从「自管 pending/error + onPatch PATCH」改为「受控 + onChange 上报」。不再自管 PATCH（父级 AutoworkTab 统一 save），toggle 点击仅 `onChange(!enableHeartBeat)`。去掉 error banner / pending 态。

边界：
- 只控 **squad.enableHeartBeat** 一个布尔（killswitch）；不配 activeWindow/interval（那些是 per-role，见 `heartbeat-config.md`）。
- 不控 budget / timezone（那些走管理 tab 其他字段 PATCH /squad）。
- 关闭后**已存在的 member.heartbeat 配置保留**（存储不动），仅 scheduler 不触发；再开即恢复。

## Props
```ts
interface SquadAutonomyToggleProps {
  /** 反映 squad.enableHeartBeat 当前值（受控：来自父级 AutoworkTab draft，非 server 直灌） */
  enableHeartBeat: boolean;
  /** 上报变更 → 父级 dirty（不再自管 PATCH） */
  onChange: (value: boolean) => void;
}
```

## 状态 / 交互
- **纯受控上报**：无本地态、无 async/PATCH 调用。
- **点击 toggle**：当前 on → 改 off；当前 off → 改 on。调 `onChange(!enableHeartBeat)`（上报父级，不直接 PATCH）。
- **状态反映**：UI 根 `squad-autonomy-toggle-{on|off}` 二态切换（视觉仅态标识不同，ET 断言二态之一存在）。
- **data-action-key** + `role="switch"` + `aria-checked={on}`。

## 视觉基线
> 本版本无设计稿（PRD §3 note），按既有 Studio 视觉对齐。**特化视觉细节由设计师后续补**。
- toggle 复用 （dark accent 实底 = on；muted = off）。
- 旁附简短说明文案（on：「自主工作已开启，成员将按心跳节奏主动运转」；off：「已暂停自主工作，成员仅响应对话」）。

## 复用关系
- **被组合**：**`component-autowork-tab`**（squad-panel「自动工作」tab 容器；自主性归位——与 budget-m
