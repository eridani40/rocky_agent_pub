# v0.0.326 变更计划书 — usage 用量环优化

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD 权威：`specs/prd/version_logs/v0.0.326-usage-ring.md`

## 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 环默认尺寸改 36 | `ComponentUsageRing` size 默认 28→36；stroke 4 不变。ring 本身不渲染文字——百分比文字由 panel caller 叠加（absolute span） | `component-usage-ring.tsx` L35-40 `size=28, stroke=4` 默认；L49-80 纯 SVG 无文字层 |
| trigger 重构 | 删 fmtK 文字 + 删 hover tooltip + 删 chevron btn → 整环 onClick toggle + cursor-pointer。open state 保留（chevron 不再需要独立 btn） | `component-usage-panel.tsx` L115-133 trigger(group+ring+fmtK+tooltip) + L134-144 chevron btn + L61 `const [open,setOpen]=useState(false)` |
| 浮层方向改左下 | 现状 `absolute top-full right-0 mt-1.5`（向↓右贴齐）。改向左下展开：trigger 容器 `relative`；浮层 `absolute top-full right-0` 不变，但宽度 300px 从 trigger 右缘向左延伸——当前 `right-0` + `w-[300px]` 即自然向左展开（trigger 在最右端，面板右缘齐 trigger 右缘） | `component-usage-panel.tsx` L148-151 浮层定位 |
| 面板 head 加按钮 | head 区（L153-157 标题+context 数字）改 flex justify-between，右侧加 CompactBtn+ClearBtn。需新增 props 透传 | `component-usage-panel.tsx` L153-157 head；`section-chat-session.tsx` L192-201 topbarRight（CompactBtn/ClearBtn 在此挂载） |
| CompactBtn/ClearBtn 移入 panel | 现 export 的独立组件，section-chat-session topbarRight 直接渲染。改为通过 ComponentUsagePanel props 透传（onCompact/onClear/summaryTask/showClear），panel 内 head 渲染 | `component-usage-panel.tsx` L240-297 CompactBtn/ClearBtn export；`section-chat-session.tsx` L25 import + L196-199 渲染 |
| CompactBtn 缩小 | 现状 `w-[30px] h-[30px]`。panel head 内缩为 `h-7 w-7`（28px）适配紧凑面板。改 className 常量 | `component-usage-panel.tsx` L267 CompactBtn className |
| 像素对齐 | topbar `px-6`=24px（base-chat-page L117）+ overlay `right-6`=24px（right-overlay L36）+ float-menu `w-8`=32px。环 36px vs float-menu 32px 半差 2px → topbarRight 容器加 `pr-0.5`（2px）使环中心右移 2px 对齐 float-menu 中心 | `base-chat-page.tsx` L117 `px-6 py-3`；`component-chat-right-overlay.tsx` L36 `right-6` |
| topbarRight 瘦身 | 删 CompactBtn+ClearBtn+竖分隔线 → 只留 `<ComponentUsagePanel>`（含环+面板内按钮）。caps 门控逻辑从 `caps.usage\|\|caps.compact\|\|caps.clear` 简化为 `caps.usage`（usage 不开则整个区域不渲染；compact/clear 透传给 panel 内部门控） | `section-chat-session.tsx` L192-201 topbarRight JSX |
| 7 消费方统一 | SectionChatSession 是唯一渲染入口（7 消费方复用），改 topbarRight 一处全生效 | `section-chat-session.tsx` L85 SectionChatSession 入口 |

## 设计决策（D 编号）

### D1: 环默认尺寸 28→36 — component-usage-ring.tsx（修改）

**文件**：`app/web/src/components/chat-page/component-usage-ring.tsx`（修改）

**变更**：
- `ComponentUsageRing` 默认 `size` 28→36（L38 `size = 28` → `size = 36`）
- stroke 默认 4 不变
- 环本身仍不渲染文字（百分比叠层在 panel trigger 层做）

**约束**：MUST size 默认 36；MUST stroke 默认 4 不变；MUST NOT 在 ring 内加文字（ring 是 primitive，文字叠层由 caller 做）；MUST NOT 改 usageRingColor 配色逻辑；MUST NOT 改 SVG 结构。

### D2: panel trigger 重构 + 浮层方向 + head 加按钮 — component-usage-panel.tsx（修改）

**文件**：`app/web/src/components/chat-page/component-usage-panel.tsx`（修改）

**变更分 5 部分**：

**① props 扩展**（L52-54 UsagePanelProps）：
```ts
interface UsagePanelProps {
  usage: SessionUsageView;
  /** 压缩回调（caps.compact 开时由 caller 透传；null=不渲染压缩按钮） */
  onCompact?: (() => void) | null;
  /** 清理回调（caps.clear && !readOnly 时透传；null=不渲染清理按钮） */
  onClear?: (() => void) | null;
  /** summaryTask 状态（CompactBtn disabled+spinner 绑定） */
  summaryTask?: SummaryTaskStatus | null;
  /** session running（CompactBtn sessionBusy 透传，兼容签名） */
  sessionBusy?: boolean;
}
```

**② trigger 重构**（L114-133 替换）：
- 删除 fmtK 文字 span（L117-119）
- 删除 hover tooltip div（L121-132）
- trigger div 加 `onClick={() => setOpen(o=>!o)}` + `cursor-pointer` + `title`/`aria-label`=i18n `usage.clickToExpand`
- trigger div 内：`<ComponentUsageRing used={used} total={total} size={36} />` 显式传 size=36
- 环上方叠百分比文字 absolute span：
  ```tsx
  <span className="absolute text-[9px] font-bold text-fg-2 font-mono pointer-events-none select-none">
    {Math.round(pct * 100)}%
  </span>
  ```
- trigger div 改 `relative` 定位（百分比 absolute 叠层基准）
- 保留 `hover:bg-bg-warm rounded-lg transition-colors`

**③ 删 chevron btn**（L134-144 整段删除）：
- chevron 展开按钮全删；open toggle 由 trigger onClick 接管
- import 的 `ChevronIcon` 从 import 列表移除（L22）

**④ 浮层 head 加按钮**（L153-157 head 区重构）：
```tsx
<div className="flex items-center justify-between mb-3">
  <div>
    <div className="text-[13px] font-bold text-fg">{t('usage.title')}</div>
    <div className="text-[10px] text-muted mt-0.5 font-mono">{fmtNum(total)} context</div>
  </div>
  {((onCompact || onClear) && (
    <div className="flex items-center gap-1">
      {onCompact && <CompactBtn summaryTask={summaryTask ?? null} sessionBusy={sessionBusy ?? false} onClick={onCompact} size="sm" />}
      {onClear && <ClearBtn onClick={onClear} size="sm" />}
    </div>
  ))}
</div>
```

**⑤ CompactBtn/ClearBtn 加 size prop**：
- CompactBtn（L241-276）：加可选 prop `size?: 'sm'`，`size='sm'` 时 className 用 `h-7 w-7`（替代 `w-[30px] h-[30px]`）
- ClearBtn（L278-297）：同上加 `size?: 'sm'` → `h-7 w-7`

**约束**：MUST trigger 整体可点击 toggle；MUST 删 fmtK 文字 + tooltip + chevron；MUST 百分比文字 text-fg-2 统一色不变色；MUST pointer-events-none 防文字拦截；MUST head justify-between 按钮右对齐；MUST CompactBtn disabled 绑 summaryTask.running 不变；MUST NOT 改浮层内容区（大圆环+分段+图例+表格）；MUST NOT 改 CompactBtn/ClearBtn 的 data-action-key；MUST NOT 改 document mousedown 关闭逻辑。

### D3: topbarRight 重构 + 透传回调 — section-chat-session.tsx（修改）

**文件**：`app/web/src/components/chat-page/section-chat-session.tsx`（修改）

**变更**：

**① topbarRight JSX 重构**（L192-201 替换）：
```tsx
const topbarRight = caps.usage && (
  <div className="flex items-center pr-0.5">
    <ComponentUsagePanel
      usage={usageHook.usage ?? emptyUsage}
      onCompact={caps.compact ? handleCompact : null}
      onClear={caps.clear && !readOnly ? () => setClearModalOpen(true) : null}
      summaryTask={summaryHook.summaryTask}
      sessionBusy={sessionRunning}
    />
  </div>
);
```
- 删 CompactBtn/ClearBtn 直接渲染 + 竖分隔线（L195-199）
- 删 `caps.compact || caps.clear` 外层条件 → 只 `caps.usage`（usage 不开则无区域）
- `pr-0.5`（2px）使环中心右移对齐 float-menu 中心线
- import 删 `CompactBtn, ClearBtn`（L25 只留 `ComponentUsagePanel`）

**② import 调整**（L25）：
```ts
import { ComponentUsagePanel } from './component-usage-panel';
```

**约束**：MUST 只 `caps.usage` 门控（compact/clear 透传 panel 内部）；MUST 保留 caps.compact/caps.clear 门控（null=不渲染对应按钮）；MUST readOnly 时 onClear=null（清理不显示）；MUST `pr-0.5` 像素对齐；MUST NOT 改 handleCompact/handleClear/handleEnqueueCancel；MUST NOT 改 clearModalOpen 逻辑；MUST NOT 改其他 slot（topbarLeft/messagesSlot/rightOverlaySlot/inputSlot）。

### D4: i18n 双语 — zh-CN/chat.json + en/chat.json（修改）

**文件**：
- `app/web/src/i18n/locales/zh-CN/chat.json`（修改）
- `app/web/src/i18n/locales/en/chat.json`（修改）

**变更**：
- 删 `usage.toggle` 对象（L258-261 两文件各 4 行：`"toggle": { "collapse": ..., "expand": ... }`）
- 加 `usage.clickToExpand`：
  - zh-CN：`"clickToExpand": "点击查看用量详情"`
  - en：`"clickToExpand": "Click to view usage details"`

**约束**：MUST 删 toggle.collapse + toggle.expand；MUST 加 clickToExpand 双语；MUST NOT 改其他 usage.* key。

## 文件级变更清单

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---------|---------|----------|------|---------|------|------|-----------|
| 1 | usage-ring | `app/web/src/components/chat-page/component-usage-ring.tsx` | `ComponentUsageRing` 默认参数 | 修改 | size 28→36 | MUST stroke=4 不变 | D1 | 1 |
| 2 | usage-panel | `app/web/src/components/chat-page/component-usage-panel.tsx` | `UsagePanelProps` | 修改 | +onCompact/onClear/summaryTask/sessionBusy 4 个可选 prop | MUST | D2① | +5 |
| 3 | usage-panel | 同上 | `import` | 修改 | 删 ChevronIcon（chevron btn 删） | MUST | D2③ | 1 |
| 4 | usage-panel | 同上 | trigger 区（L114-133） | 修改 | 删 fmtK 文字+tooltip；加 onClick toggle+cursor-pointer+title；环 size=36 显式传；叠百分比 absolute span | MUST text-fg-2；MUST pointer-events-none | D2② | ~-20/+12 |
| 5 | usage-panel | 同上 | chevron btn（L134-144） | 删除 | 整段删 | MUST | D2③ | -11 |
| 6 | usage-panel | 同上 | 浮层 head（L153-157） | 修改 | 改 flex justify-between + 右侧 CompactBtn/ClearBtn 条件渲染 | MUST 按钮右对齐 | D2④ | ~-3/+10 |
| 7 | usage-panel | 同上 | `CompactBtn` | 修改 | +size?:'sm' prop → h-7 w-7 | MUST disabled 逻辑不变 | D2⑤ | +4 |
| 8 | usage-panel | 同上 | `ClearBtn` | 修改 | +size?:'sm' prop → h-7 w-7 | MUST | D2⑤ | +4 |
| 9 | chat-session | `app/web/src/components/chat-page/section-chat-session.tsx` | `import` | 修改 | 删 CompactBtn,ClearBtn；只留 ComponentUsagePanel | MUST | D3② | 1 |
| 10 | chat-session | 同上 | `topbarRight` JSX（L192-201） | 修改 | 删 CompactBtn/ClearBtn/竖分隔线；改 caps.usage 单门控+pr-0.5+props 透传 | MUST onCompact/onClear 透传；MUST pr-0.5 对齐 | D3① | ~-9/+10 |
| 11 | i18n | `app/web/src/i18n/locales/zh-CN/chat.json` | `usage.toggle` | 删除 | 删 toggle 对象（4 行） | MUST | D4 | -4 |
| 12 | i18n | 同上 | `usage.clickToExpand` | 新增 | "点击查看用量详情" | MUST | D4 | +1 |
| 13 | i18n | `app/web/src/i18n/locales/en/chat.json` | `usage.toggle` | 删除 | 删 toggle 对象（4 行） | MUST | D4 | -4 |
| 14 | i18n | 同上 | `usage.clickToExpand` | 新增 | "Click to view usage details" | MUST | D4 | +1 |

## 范式归属（逐控件）

| 控件/操作 | 范式 | 理由 |
|-----------|------|------|
| 环点击展开/收起 | **即时操作**（toggle） | 点击 toggle open state，无确认 |
| 面板关闭（点外部） | **即时操作**（document mousedown，既有） | 既有逻辑不变 |
| 压缩按钮 | **即时操作**（点击触发 compact，running disabled） | 既有范式不变，仅位置变 |
| 清理按钮 | **L3 确认 modal**（clear-confirm-modal，既有） | 既有范式不变，仅位置变 |
| trigger hover bg | **视觉反馈**（hover:bg-bg-warm） | 非交互，纯感官 |

**结论**：不引入新范式，按钮位置从 topbar 移入 panel head，交互范式不变。

## 像素对齐计算

```
topbar px-6 = 24px from right edge
overlay right-6 = 24px from right edge
→ 两基准一致（topbarRight 右缘 = overlay 右缘 = 24px from viewport right）

float-menu w-8 = 32px → 中心线距右缘 = 24 + 32/2 = 40px
环 36px → 默认中心线距右缘 = 24 + 36/2 = 42px（topbarRight 右缘=24px + 环宽36px/2）

差值 = 42 - 40 = 2px（环中心比 float-menu 中心偏左 2px）

修正：topbarRight 容器加 pr-0.5（=2px right padding）
→ 环右缘 = 24 - 2 = 22px from right
→ 环中心 = 22 + 18 = 40px from right = float-menu 中心 ✓
```

## 影响面评估

- **跨模块**：usage-ring（尺寸）/ usage-panel（trigger 重构 + head 加按钮 + Btn size）/ section-chat-session（topbarRight 重构）/ i18n —— 全前端
- **破坏性变更**：
  - `UsagePanelProps` 新增 4 个可选 prop —— 向后兼容（全可选，缺省=null 不渲染按钮）
  - `CompactBtn`/`ClearBtn` 新增 `size?:'sm'` 可选 prop —— 向后兼容
  - `topbarRight` 从直接渲染 CompactBtn/ClearBtn 改为透传 —— section-chat-session 同版本同步改（唯一消费方）
  - i18n 删 `usage.toggle.*` —— chevron btn 删后无消费方，安全删除
- **零后端 / 零 IPC / 零数据链路改动**
- **依赖顺序**：D1（ring 尺寸）独立；D2（panel）依赖 D1；D3（chat-session）依赖 D2；D4（i18n）独立可并行
- **UT 覆盖面**：
  - `component-usage-ring.test.tsx`（改）—— size 默认 36 断言
  - `component-usage-panel.test.tsx`（新建或改）—— trigger 点击 toggle + 百分比文字渲染 + fmtK 删除 + chevron 删除 + head CompactBtn/ClearBtn 渲染 + onCompact/onClear 回调触发 + CompactBtn disabled 绑 summaryTask
  - `section-chat-session.test.tsx`（改）—— topbarRight 只渲 ComponentUsagePanel + caps 门控 + readOnly 时 onClear null
- **ET 建议**：环像素对齐 float-menu + 面板左下展开方向 + 面板内压缩/清理按钮可见性（视觉验证为主）
