# v0.0.350 API change_log — 四渠道 coding plan native + 额度/余额查询

## 变更（2026-08-15，architect 即时同步）

### `specs/api/overall/02-llm-chat.md`（1.7 → 1.8）

- §5.1 端点表：**新增 `GET /provider/quota`**（coding plan 额度/余额聚合查询，见 §5.6）。
- §5.2 `ProviderInstance.name`：`"anthropic_compatible"` 字面量 → **`ProviderName` union**（+`kimi_coding_plan` / `glm_coding_plan` / `minimax_coding_plan` / `deepseek_api`；POST/PUT 白名单校验，缺省 anthropic_compatible 向后兼容——旧 client 不传 name 不 400）。
- §5.4：name 白名单扩 5 值注记（白名单外 400 不变）。
- **新增 §5.6** `GET /provider/quota` 契约：
  - 聚合语义（一次返回全部 4 native provider 快照；通用类型不参与；server 不缓存 15s 超时现拉）；
  - `QuotaSnapshot`/`QuotaTier` 统一形状（kind quota/balance、tiers 已用百分比、membership、balance、isAvailable、error、fetchedAt）；
  - 错误隔离（单渠道失败 item.error 不炸整体；零 native → items:[]）；
  - 实现约束注记（baseUrl 子串推导查询域；glm 裸 api_key；解析规则权威 = live-verify 实测 + cc-switch）。
- `ProviderUpdateBody`：**新增可选 `name` 字段**（白名单内才写——已存 provider 切换类型通道；PUT 不传 name 不变，向后兼容）。

## 关联

- 权威契约：`specs/tech/version_logs/v0.0.350/change_plan.md`（决策②⑤⑦⑧）
- PRD：`specs/prd/v0.0.350-native-coding-plans-and-balance-query.md`

## 决策演进追记（v0.0.363，doc-modifier）

> 版本轴历史不改写上文；决策演进在此追加。

上节「聚合语义（server 不缓存 15s 超时现拉）」已被 **v0.0.363 推翻**：`GET /provider/quota` 改读 server 全局 QuotaStore 秒回（响应加 `lastSyncedAt`；启动空窗 `{items:[],lastSyncedAt:null}`），同步由 QuotaSyncService 5min 后台轮 + 启动首轮 + 新端点 `POST /provider/quota/sync` 打开触发（202 fire-and-forget），store 更新经 SSE topic `provider_quota`（广播 `_all`）推送。spec 现行契约见 `02-llm-chat.md` §5.6/§5.6b/§5.6c（1.9）；决策演进详见 `specs/tech/version_logs/v0.0.363/change_log.md`。
