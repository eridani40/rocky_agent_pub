# workspace_file_version_tc1

- 版本：v0.0.320 文件预览区
- 模块：workspace
- 设计：api-test-designer
- 契约依据：specs/api/version_logs/v0.0.320/change_log.md §1.1 + specs/api/overall/04-agent-session.md §2.6

## 目标

验证 `GET /session/:id/workspace/file?path=` 返回 version 字段（`${mtimeMs}:${size}` 格式），
且重复读取返回内容一致、version 格式稳定。

## 前置（setup）

1. `POST /session {title}` → 200，取 `sid`（不传 workspaceDir → 后端自动建 `<DATA_DIR>/workspaces/{sid}`）
2. files 原语写 `workspaces/{sid}/notes.md`（内容 dict 序列化为 JSON 文本，含 marker `ws-version-content`）

## 步骤与断言

| # | 请求 | 断言 |
|---|------|------|
| 1 | `GET /session/{sid}/workspace/file?path=notes.md` | 200；`.content exists` + `.content ~= "ws-version-content"`；`.version exists` + `.version ~= ":"`（mtimeMs:size 格式） |
| 2 | 同上再读一次 | 200；`.content ~= "ws-version-content"`；`.version exists` + `.version ~= ":"`（格式稳定） |

## teardown

- `DELETE /session/{sid}`（204/404 容忍）

## 设计权衡（AT 边界）

- **version 精确相等不可断**：AT check 引擎不支持跨响应变量比较（check 右侧不插值），
  因此「两次读 version 完全相同」退化为「两次均存在 + 格式稳定」断言。
  version 派生确定性（同 mtime/size → 同 version）由 UT（session-workspace-file.test.ts）覆盖。
- **binary=1 分支不加 version**：本 case 只测文本路径（path 无 binary=1），
  二进制分支由 UT 覆盖。
- 不调 LLM，全确定性。
