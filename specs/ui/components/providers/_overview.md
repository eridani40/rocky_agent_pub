# providers 子系统 UI spec

> 层级: 子系统（app config → providers group 的内容区）

## 数据源
REST CRUD 无 SSE——挂载 `GET /provider` 一次取 `{ items: ProviderInstance[], protocols: ProtocolMeta[] }`（protocols cache 共享给 component-provider-fields）；CRUD：`POST /provider`（新建）、`PUT /provider/:id`（改 label/baseUrl/apiKey/enabled/protocolId）、`DELETE /provider/:id`（级联删 models）；model：`POST /provider/:id/model`、`PUT /provider/:id/model/:modelId`、`DELETE /provider/:id/model/:modelId`。无 SSE topic，所有变更由本组件命令式 refetch 兜底。

## 2. 数据模型（对齐我们的定义）
### ProviderInstance（**v0.0.53 修订** += protocolId）
- ** 新增 `protocolId: ProtocolName`**（必填，1 provider : 1 protocol 锁定，单一事实源；从 model 迁来）
- 列表/二级页外显：`label`（名称）、`baseUrl`、`enabled`（启用状态）、`models.length`（模型数）
- `credentials.key` 在二级页以 password 输入编辑（响应已脱敏 `***`，编辑时整体覆盖）
- ** 二级页加 protocol 下拉（编辑 protocolId）+ 拼接地址 mono 展示**（见 §5 component-provider-fields）
### ModelInstance
- （显示名，区分同 provider 下多个 model）
- （启停；关闭后在模型选择器隐藏）
- **  字段删除**
### ProtocolMeta（，`GET /provider` 响应顶层附带）
- 用途：protocol 下拉选项（id 作 value / label 作展示文本）+ 拼接地址（`baseUrl + path` 实时预览）
- 加载：`section-providers` 进 list 视图时拉一次 `GET /provider` 拿到 items + protocols，cache 共享给 component-provider-fields

## 4. 状态机 + 保存逻辑（section-providers）
### 视图层状态
- list → detail：点 provider 卡（pid=已存 id）或「添加提供商」（pid='new'）
- detail → list：面包屑「模型提供商」/ 返回按钮 / 保存成功后
### draft / snapshot（detail 层持有）
- 进入 detail：`snapshot` = 当前已持久化 provider 深拷贝（new provider 则空）；`draft` = 深拷贝
- model 操作（经 modal「确定」回写 draft，不经后端）：
  - 添加 model：modal 确定 → push 新 model 到 `draft.models`
  - 编辑 model：modal 确定 → 替换 `draft.models[i]` - 删除 model：model 卡删除按钮 → 从 `draft.models` 移除

## 视觉基线
- 列表 header：`config-title`(模型提供商) + `config-desc`(model_config · N 个提供商 · M 个模型) mono
- 二级页 header：面包屑（可点回上层）+ logo + title + desc
- section-title + section-desc + hr section-divider 分段（连接配置 / 关联模型）
- 表单控件复用 primitive：input 走 `f-input` 规格
