# section-default-models-and-request（模型 tab 第二+第三 group 渲染）

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/section-default-models-and-request.tsx

## 职责
模型 tab 下两个 KV group 的渲染区：
1. **playground 默认模型** group（新 group `app_config/default_models`，单 record key=`default`）
   - `chat`：默认会话模型——**复用统一的 `chat/ModelPicker` 组件**（squad 管理同款：无搜索、trigger 与下拉选项均 `provider / model` 风格），v0.0.230 验收返工起不再用独立 KeyModelPicker
   - **清除交互在组件外层**：ModelPicker 本体只负责选项、不含清除；配置页在右侧包 x 清除按钮（始终渲染固定占位，空态 `visibility:hidden` 保布局稳定，aria-label=i18n `defaultModels.clear`）
   - `chat` 字段 optional；x 清除写 `undefined`（删字段，不删 record）
   - value 适配：落盘 = 纯 modelId string；外层用 `findProviderIdByModelId(providers, value)` 反查组装复合 `ModelSelection` 喂 ModelPicker（无值/反查不到 → `null` 显「选择 model」占位）；onChange 只存回 `sel.modelId`
2. **请求设置** group（暴露 `app_config/llm_request/default` 嵌套对象已有子字段）

## 数据源
REST CRUD 无 SSE——本 section 纯展示 + 上抛变更。draft + 保存由 `useAppSettingsConfig` + `app-settings-persist.ts` 持有：
- default_models：`PUT /config/app` body={group:'default_models',key:'default',data:{chat?}} 整 record 覆盖。
- llm_request：read-modify-write——基于完整 snapshot 改 `timeout.stall_tool_s` / `retry.max_attempts` 后 `PUT /config/app` body={group:'llm_request',key:'default',data:fullSnapshot} 整 record 提交（不丢其他子字段）。

## Props
- defaultModelsDraft: { chat?: string }
- onDefaultModelsChange: (key: 'chat', value: string | undefined) => void
- llmRequestDraft: { stall_tool_s: number; max_attempts: number }
- onLlmRequestChange: (key: 'stall_tool_s' | 'max_attempts', value: number) => ...
