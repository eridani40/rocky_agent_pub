---
type: api
title: 11b. Squad Templates
updated: 2026-08-08
---

# 11b. Squad Templates

## §1 GET /squad-templates — 列出全部模板

### 请求

```
GET /squad-templates
```

无 query 参数。

### 响应 200

```json
{
  "items": [
    {
      "slug": "webapp-dev-team",
      "name": "WebApp Dev Team",
      "description": "完整的 WebApp 研发团队",
      "builtin": true,
      "memberCount": 11,
      "leaderName": "Darvin"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| slug | string | 唯一标识（kebab-case） |
| name | string | 显示名 |
| description | string | 一句话描述 |
| builtin | boolean | 是否 builtin（随 app 打包） |
| memberCount | number | mate 数量（不含 leader） |
| leaderName | string | 预填 leader 名（UI 预填用，来自 manifest.leaderName） |

### 错误

| 状态码 | error | 说明 |
|---|---|---|
| 500 | template_list_failed | 扫描模板目录失败 |

## §2 POST /squad — 从模板创建（扩展）

POST /squad 请求体新增可选字段 `templateSlug`。无此字段时行为不变（向后兼容）。

### 请求体（扩展后）

```json
{
  "name": "My Team",
  "modelDefault": "claude-sonnet-4",
  "modelDefaultProviderId": "provider_xxx",
  "leader": { "name": "Boss" },
  "templateSlug": "webapp-dev-team"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| name | string | 是 | squad 名 |
| description | string | 否 | squad 描述 |
| modelDefault | string | 是 | 默认 modelId |
| modelDefaultProviderId | string | 否 | modelDefault 配对 providerId |
| leader.name | string | 是 | leader 名 |
| templateSlug | string | 否 | 模板 slug；有值时按模板批量 hire + 复制配置 |

### 响应

与无模板时一致：201 + SquadDetail（含全部 members）。

### 模板应用流程

1. **建 squad + leader**（复用 createSquadService，leader.name 用用户填的值）
2. **读模板 manifest**（squad-templates/{templateSlug}/manifest.json）
3. **批量 hire mate**（遍历 manifest.members，createMemberService mode=fresh）
4. **复制配置文件**（AGENTS.md → squad 根；.rocky/{agents,skills,memory,templates,commands} → 新 squad）

### 错误

| 状态码 | error | 说明 |
|---|---|---|
| 400 | name required / modelDefault required / leader.name required | 入参校验（不变） |
| 400 | template_not_found | templateSlug 对应模板不存在 |
| 400 | invalid_template | manifest.json 格式错误 |
| 500 | create squad failed | 事务失败（不变） |

### 注意

- 批量 hire 某个 member 失败时**不中断**（best-effort），最终返回的 SquadDetail 包含已成功创建的 members
- 文件复制失败时 best-effort（console.warn），不阻断创建
- leader.name 不强制用模板 leaderName（用户可改），leaderName 仅用于 UI 预填
