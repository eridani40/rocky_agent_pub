# v0.0.321 API 变更日志 — 团队导出选择器 + leader agent 实名命名修复

> 版本轴变更说明。OKF 规范：本文件记录 v0.0.321 的 API 契约变化；正文（overall/）由 doc-modifier 收口同步。

## 结论：**本版本零 API 契约变更**

| 维度 | 结论 |
|------|------|
| 新增端点 | 无 |
| 修改端点 | 无 |
| 删除端点 | 无 |
| 请求/响应结构 | 无变化 |

## 变更说明

### 一、团队导出选择器（纯前端）

复用既有契约，**后端零改动**：

| 复用 API | 方法 | 用途 |
|----------|------|------|
| `GET /squad` | 已存在 | 弹选择器拉团队列表（`listSquads()` → `SquadSummary[]`，后端按 updatedAt desc 排序） |
| `GET /squad/:id/export` | 已存在 | 选中后下载 zip（`exportSquad(squadId)`，`<a href download>` 不经 fetch） |

### 二、leader agent 实名命名修复（纯内部 service 逻辑）

- `squad-template-service.ts` `copyTemplateFiles` / `applyTemplate` 加可选 `leaderName` 参数
- `handlers/squad.ts` `handleCreateSquad` 调用追加 `body.leader.name`
- `team-sync-import-service.ts` `importSquadFromTempDir` 调用追加 `manifest.leaderName`
- `team-sync-export-service.ts` 新增 `restoreAgentFileName(fileName, leaderName?)`（导出还原实名 → 模板 key）

以上均为**服务层内部实现细节**，不改变任何 HTTP 请求/响应契约。

## 测试覆盖说明

- 后端行为由 **UT** 覆盖（3 个测试文件更新断言，不留旧 `leader-` 断言）
- 不新增 AT case（无 API 变更，既有 AT 回归即可）
