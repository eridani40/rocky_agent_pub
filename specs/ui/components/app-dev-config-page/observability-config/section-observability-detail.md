# section-observability-detail

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/observability-config/section-observability-detail.tsx
> 视觉契约: reqs/v0.0.11/easy-opc-config-v10.html L476-553（ObsDetailEditor）+ reqs/v0.0.11/detail.png

## 职责
可观测性详情/编辑视图：breadcrumb + 头部（logo + 名称 + type + 启停）+「基础信息」section（name + type + baseUrl）+「认证密钥(仅本地)」section（publicKey + secretKey）+ save-bar（dirty 指示 + 重置 + 保存）。支持新增与编辑两种模式。
**数据源**：REST CRUD 无 SSE——draft 仅前端持有，save 上抛父级 `section-observability.tsx` 合并入整 list 后 `PUT /config/app` body={group:'runtime',key:'observability',data:observabilityConfigs[]} 整 record 覆盖（`secretKey` 明文回传，后端 `***` 哨兵走 merge）。toggle 同 list 语义即时走整 list PUT。
边界：不管列表（→ list）；启停 toggle 即时生效（同 list 项 toggle 语义）。

## Props
- initialData: ObservabilityConfig;  // 新增时由父级构造空壳 {name:'',type:'langfuse',bas...
- isNew: boolean
- onBack: () => void;                              // 返回 list
- onSave: (data: ObservabilityConfig) => void;     // 保存（落库归 tech manager）
- onToggle: (id: string, enabled: boolean) => void; // 头部 toggle 即时（编辑态）

## 状态 / 交互
- `draft: ObservabilityConfig`（受控编辑副本），初始 = initialData。
- `saved: ObservabilityConfig`（已保存基线），初始 = initialData。
- 头部 toggle：`onToggle(initialData.id, !draft.enabled)` + 本地同步 draft.enabled（编辑态）；新增态 toggle 禁用（无 id，先保存）。
- **保存按钮** `disabled={!isDirty}`；点击 → `onSave(draft)` → 父级落库 + 返回 list。
- breadcrumb：「可观测性 / {name 或 新建配置}」；点「可观测性」→ `onBack`。
- **必填校验**（保存前）：`name` / `baseUrl` / `publicKey` / `secretKey` 非空；任一空 → 保存按钮禁用（在 `!isDirty` 之上叠加；UI 不弹错，仅 disable）。
### name/type 竖排（用户决策②，MANDATORY，对设计稿差异）
设计稿 `f-row-inline`（横排一行两栏）→ **本 spec 改为竖排**：name 与 type 各占一整行 `f-row`，两行独立 full-width input。type input `disabled`，值固定 `langfuse`。

## 复用关系
- 被组合：`section-config-layout`（dev config 页 observability group → detail 视图）
- 复用 primitive：toggle、text input（直接 `f-input` 类 / `pr
