# v0.0.240 api change_log — panorama 端点 v1.3（builtin schema + view.filter + 归档）

> 类型：panorama 端点契约扩展（无新端点）。task 走通用 panorama 端点（POST entities/task / PATCH / transition），方案 A+ 决策——不造专用工具/端点。
> 端点权威：`specs/api/overall/14-panorama-endpoints.md` v1.3（已就地更新）。变更契约：`specs/tech/version_logs/v0.0.240/change_plan.md`。

## 端点行为变更（v1.3）

| 端点 | v1.3 变更 |
|------|----------|
| `GET /squad/:id/panorama/schema` | 响应 `dsl` 仍为**纯 leader DSL 文本**（不含 builtin）；前端 `mergeBuiltinSchema` 注入 builtin task entity + view（builtin 是前端镜像常量，无需后端返回）。空 board → `{dsl:null}`，前端合成纯 builtin（task tab 恒在） |
| `GET /squad/:id/panorama/entities/:entity` | `?filter=k:v,k2:v2` 透传（前端 view.filter 序列化）；`entity=task` 永远 200（effective schema 合并 builtin，即便 DSL 空），409 schema_not_defined 对 task 例外 |
| `POST /squad/:id/panorama/entities/:entity` | entity=task 时 `applyFieldDefaults` 给未传 boolean 字段（archived）补 false；写后 `afterTaskWrite` 重算依赖自动 transition（source=system） |
| `PATCH /squad/:id/panorama/entities/:entity/:id` | 归档 = PATCH `archived:true`（普通 boolean 字段更新，无新端点）；task patch 触碰 dependencies/status → afterTaskWrite 重算 |
| `POST /squad/:id/panorama/entities/:entity/:id/transition` | entity=task → transitionInstance 后调 afterTaskWrite（todo→done 触发依赖该 task 的 waiting 解除） |
| SSE `panorama_entity_update` | 新增 `source: 'system'`（task 自动依赖 transition 用）；前端收到正常乐观更新 |

## PRD 路径 → API 映射（§5.2 新增）

| PRD 路径 | 覆盖端点 |
|----------|---------|
| P1.T1 agent create task（含 dependencies 自动 waiting） | POST entities/task + hook 自动 transition（SSE source=system） |
| P1.T2 依赖 task done → 被依赖自动 todo | POST transition（done）+ hook |
| P1.A1 卡片归档按钮 | PATCH entities/task `{patch:{archived:true}}` |
| P1.A2 切「含归档」开关 | GET entities/task（filter override） |
| P1.E1 leader DSL 写带 filter 的 table view | PUT schema（view 加 filter）+ GET entities（前端透传） |
| P1.E2 task 表头中文 | GET schema（builtin task display.status_labels 前端镜像配死中文） |

> 无新 HTTP 端点。所有 task 操作走通用 panorama 端点（POST/PATCH/transition + events + SSE）。
