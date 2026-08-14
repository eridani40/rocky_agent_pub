# section-bash-config（应用设置 → 工具 → Bash 工具 自渲染 section）

> 层级: section
> 本文是「Bash 工具」section 的**概念权威源**：bash_seatbelt 沙箱开关 + 受控保存 + 重启生效提示。
> 蓝本: `specs/ui/components/app-dev-config-page/section-see-image-config/_overview.md`（同构 forwardRef + aggregator 范式）。

## 1. 概念定位

Bash 工具是 **tools tab 内的一个自渲染 section**（`section-tab-panel.tsx` 工具 tab 内渲染）：
- 单字段 `bash_seatbelt`（boolean 沙箱开关），存 app_config `runtime` group。
- `ToggleSwitch` 控制 draft；dirty 时展示「重启生效」提示。
- 不消费 `useAppSettingsConfig`，不进 `app-settings-config-defs.ts` 的 KV_GROUPS（自渲染，与 see_image/web_fetch 同范式）。

## 2. 数据模型（UI 侧契约）

- GET `/config/app?group=runtime&key=bash_seatbelt` → `{ value: boolean | null }`；**null / 缺失 → baseline = true**（安全默认：沙箱默认开启）。
- 单 key PUT `/config/app`：`{group:'runtime', items:[{key:'bash_seatbelt', data:draft}]}`。

## 3. 保存模型（v0.0.316 统一保存受控化）

section **不自带保存按钮**，改为受控组件接入 tab 级统一保存（`page-app-settings-merged.tsx` 工具 tab + `use-tab-dirty-aggregator.ts`）：
- **`forwardRef` + `useImperativeHandle`** 暴露 `SectionSaveHandle { save, reset }`——save = 单 key PUT（成功后 `baseline = draft` 清 dirty）；reset = draft 回 baseline。
- **`onDirtyChange?: (dirty) => void` prop**：`dirty = draft !== baseline`，变化时声明式上报（驱动 tab 级 save bar 亮/灭）。
- **save 可行性**：`!dirty` 短路（handleSave 内直接 return）。
- **内部状态**：baseline / draft / loading / error / saving；挂载时 GET 拉 baseline。

## 4. 视觉基线

- section 容器：`flex flex-col gap-3`。
- 顶部说明区：`text-[11px] text-muted font-mono` 描述文案（`bash.sectionDesc`）。
- toggle 行：`flex items-center gap-3`——ToggleSwitch（`actionKey="bash-seatbelt-toggle"`）+ 旁标 label（`bash.toggleLabel`）。
- dirty 时追加 `bash.restartNotice` 重启生效提示（`text-[11px] text-muted`）。
- loading / error 态与 see-image 同款（`observability.loading` / `role="alert"` + retry）。

## 5. 消费方

- `section-tab-panel.tsx`（工具 tab 内 `<SectionBashConfig ref={...} onDirtyChange={...} />`）——唯一渲染入口。
