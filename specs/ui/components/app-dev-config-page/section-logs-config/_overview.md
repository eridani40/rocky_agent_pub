# section-logs-config（应用设置 → 可观测性 tab → logs group section）

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/section-logs-config.tsx
> 蓝本: `specs/ui/components/app-dev-config-page/section-bash-config/_overview.md`（同构 forwardRef + aggregator 范式）。

## 1. 概念定位

日志开关（logs）是 **可观测性 tab 内的一个自渲染 KV group section**（v0.0.317 新增）：
- **7 个 boolean toggle**（`KV_GROUPS` logs group 的 key 定义，`app-settings-config-defs.ts`）：enableLlmRequestLog / enableToolResultLog / enableAppApiLog / enableEventLog / enableErrorLog / enableAgentLog / enablePerformanceLog。
- 每 key 一个 `ComponentKeyCard` 受控渲染（toggle 变化只改 draft，不调 API）。
- 不消费 `useAppSettingsConfig`（自渲染，与 bash/web_search 同范式）；key 定义（type/desc/labelKey）来自 `KV_GROUPS`。

## 2. 数据模型（UI 侧契约）

- GET `/config/app?group=logs` → items[]；每个 key 缺失 → `defaultFor(type)` 兜底（boolean 缺省 false）。
- 保存：PUT `/config/app` `{group:'logs', items:[{key, data:draft[key]}, ...]}`（全 7 key 整组提交）。
- baseline / draft 均 `Record<string, unknown>`；draft 变更走 `structuredCloneSafe` 防引用共享。

## 3. 保存模型（v0.0.317 统一保存受控化）

section **不自带保存按钮**，改为受控组件接入 tab 级统一保存（可观测性 tab aggregator）：
- **`forwardRef` + `useImperativeHandle`** 暴露 `SectionSaveHandle { save, reset }`——save = 整组 PUT（成功后 `baseline = clone(draft)` 清 dirty，失败 `reload()`）；reset = draft 回 baseline。
- **`onDirtyChange?: (dirty) => void` prop**：`dirty = shallowDiff(draft, baseline)`（浅比较），变化时声明式上报（驱动 tab 级 save bar 亮/灭）。
- **save 可行性**：`!dirty` 短路（handleSave 内直接 return）。
- **内部状态**：baseline / draft / loading / error；挂载时 GET 拉 baseline。

## 4. 视觉基线

- 容器：`flex flex-col`，逐 key 渲染 `ComponentKeyCard`（keyInfo 由 LOGS_DEF.keys 映射，value 注入 draft）。
- loading / error 态：`Loading…` / `role="alert"` + Retry 按钮。

## 5. 消费方

- `section-tab-panel.tsx`（可观测性 tab 内 `<SectionLogsConfig ref={...} onDirtyChange={...} />`，标题 `group.logs.label`）——唯一渲染入口。**detail 视图（obsInDetail）时隐藏**：新增/编辑可观测性配置时隐藏「日志」group，避免 detail 下滚看到 tab 内其他内容。
