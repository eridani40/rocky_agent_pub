# workspace_stat_tc4

- 版本：v0.0.339 文件打开策略
- 模块：workspace
- 设计：api-test-designer
- 契约依据：specs/tech/version_logs/v0.0.339-file-open-strategy/change_plan.md A1 + 实现 session-workspace-file.ts handleWorkspaceStat（test-plan §3.2 规格）

## 目标

验证 `GET /session/:id/workspace/stat?path=<rel>` 端点 5 态：
正常文件返 size / 目录 404 / 越界 400 / 非 GET 405 / session 不存在 404。

## 前置（setup）

1. `POST /session {title}` → 200，取 `sid`（workspaceDir 自动建 `<DATA_DIR>/workspaces/{sid}`）
2. files 原语写 `workspaces/{sid}/data.md`（正常文件）+ `workspaces/{sid}/subdir/keep.txt`（建目录 fixture）

## 步骤与断言

| # | 请求 | 断言 |
|---|------|------|
| 1 | `GET /session/{sid}/workspace/stat?path=data.md` | 200；`.size exists` + `.size >= 1` |
| 2 | `GET /session/{sid}/workspace/stat?path=subdir`（目录） | **404**；`.error exists` |
| 3 | `GET /session/{sid}/workspace/stat?path=../evil`（越界） | **400**；`.error exists` |
| 4 | `POST /session/{sid}/workspace/stat?path=data.md`（非 GET） | **405**；`.error exists` |
| 5 | `GET /session/01KZZZZZZZZZZZZZZZZZZZZZZZZ/workspace/stat?path=data.md`（session 不存在） | **404**；`.error exists` |

## teardown

- `DELETE /session/{sid}`（204/404 容忍）

## 设计说明

- **fixture**：files 原语（DATA_DIR 相对路径 `workspaces/{sid}/`）与 session 自动 workspaceDir 匹配；
  subdir/keep.txt 同时验证目录存在（step2 目录 404 而非文件 not found）。
- **check 操作符**：check_engine 仅支持 `>= <= == != ~= !~=`（无 `>`/`<`），size 断言用 `.size >= 1`。
- **越界路径**：`../evil` 触发 resolveWsFilePath traversal 拒绝 → 400（对齐 change_plan A1）。
- **不存在 session**：硬编码无效 ULID `01KZZZZZZZZZZZZZZZZZZZZZZZZ`（不依赖清理残留，确定性）。
- **非 GET**：POST 同 URL → handler method 校验 → 405。
- 纯 HTTP + files 原语，不调 LLM，全确定性。
