# section-default-models-and-request（模型 tab 第二+第三 group 渲染）

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/section-default-models-and-request.tsx

## 职责
模型 tab 下两个 KV group 的渲染区：
1. **playground 默认模型/方案挂载** group（T6 起合并为**二选一单 select**，老板 2026-08-14 21:44 拍板）
   - `chat` + playground 方案挂载（`model_routing` group key=default 的 `playgroundPlanId`）合并渲染——**复用新组件 `common/ModelOrPlanPicker`**（T6 新增：trigger 复用 ModelPickerTrigger；panel 上组「模型」/下组「方案」，选中互斥替换）
   - 显示值 = 挂载优先（对齐 resolve 真值）：mountDraft ? {kind:'plan'} : dmDraft.chat ? {kind:'model'} : null
   - 互斥写策略（22:22 严格互斥拍板）：选模型 → 挂载清（PUT `{}`）+ chat 写；选方案 → chat 清（PUT default_models `{}`）+ 挂载写 `{playgroundPlanId}`——**双向清，至多一个有值**；saveTab 先清后写（崩溃安全：中断落双空合法态）
   - **清除交互在组件外层**：右侧包 x 清除按钮（两 draft 同清=真未设置态，空态 `visibility:hidden` 保布局稳定，aria-label=i18n `defaultModels.clear`）
   - value 适配：模型落盘 = 纯 modelId string（`findProviderIdByModelId` 反查组装复合 ModelSelection）；方案落盘 = planId
2. **请求设置** group（暴露 `app_config/llm_request/default` 嵌套对象已有子字段）

## 数据源
REST CRUD 无 SSE——本 section 纯展示 + 上抛变更。draft + 保存由 `useAppSettingsConfig` + `app-settings-persist.ts` 持有：
- default_models：`PUT /config/app` body={group:'default_models',key:'default',data:{chat?}} 整 record 覆盖。
- 方案挂载（T6 新增）：`savePlaygroundMount(planId|null)` → `PUT /config/app` body={group:'model_routing',key:'default',data:{playgroundPlanId}|{}}；挂载 draft 并入 default tab saveTab（保存按钮单一入口，先 default_models 后挂载）。
- llm_request：read-modify-write——基于完整 snapshot 改 `timeout.stall_tool_s` / `retry.max_attempts` 后 `PUT /config/app` body={group:'llm_request',key:'default',data:fullSnapshot} 整 record 提交（不丢其他子字段）。

## Props
- defaultModelsDraft: { chat?: string }
- onDefaultModelsChange: (key: 'chat', value: string | undefined) => void
- mountDraft: string | null（playgroundPlanId，T6 新增）
- onMountChange: (planId: string | null) => void（T6 新增）
- llmRequestDraft: { stall_tool_s: number; max_attempts: number }
- onLlmRequestChange: (key: 'stall_tool_s' | 'max_attempts', value: number) => ...
