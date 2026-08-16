# v0.0.349 API change_log — provider 删除入口 + 方案 dangling 双语义

## 变更（2026-08-15，architect 即时同步）

### `specs/api/overall/21-model-routing.md`（1.0.0 → 1.1.0）

- 新增 **§2.7 dangling 语义**（方案内 provider/model 失效，老板 2026-08-14 22:00 拍板）：
  - runtime 拿不到就跳过（容错）：路由循环既有防御 + **全 dangling → chat/run 入口降级 `MODEL_NOT_CONFIGURED` 400**（message 区分「方案内所有模型不可用」）；MUST NOT 静默回退默认模型（D11）。
  - 重新编辑有失效 item 拦保存（严格）：§2.2 既有校验语义确认（`model not found or disabled` 400）；前端本地预检同步（非 API 面）。
  - 非目标：删除 provider 不做方案引用实时扫描端点。
- 端点/形状/错误码表零变更（无新端点、无破坏性变更）。

### `specs/api/overall/02-llm-chat.md`（版本号未 bump——零契约变更注记）

- §5.1 DELETE `/provider/:id` 实现说明后补 **[v0.0.349] UI 删除入口补充**注记：详情页删除入口 + 通用引用警示文案；API 契约零变更（DELETE 端点早已存在，仅 UI 此前无入口）；删除后 dangling 语义指向 21 §2.7。

## 关联

- 权威契约：`specs/tech/version_logs/v0.0.349/change_plan.md`（决策②④⑨ + spec-sync 行）
- 需求：`reqs/v0.0.349.provider-delete-and-dangling-plan-items.md`
