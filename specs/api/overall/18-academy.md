# 18. Academy API（v0.0.210 新建）

> 定位：academy 板块 HTTP 端点契约。本文件描述 URL / method / body / response；schema 权威源 = `specs/tech/academy/[P0]data_model.md`；状态机权威源 = `specs/tech/academy/[P0]training_engine.md`。
> 命名约定：URL 前缀 `/academy/`（与 design.md 拼写一致）；返回 JSON。

## 1. 教室 + 学生 + 版本（CRUD）

### 1.1 POST /academy/classroom — 创建教室

```
POST /academy/classroom
Body: {
  name: string,
  logo?: string,
  /** 教室级默认模型（json 透传，复合 ModelSelection：{providerId?, modelId}）。
   *  用途：① 建学生播种 0.0 初始版本 fallback 链中间档；② head/coach 会话 picker 顶部「默认模型」项数据源。
   *  对齐 squad.modelDefault；**创建即必填（v0.0.230：缺省 → head session resolve 400 model_not_configured，无 app 默认兜底）**；
   *  存量未配教室 → picker 不显默认项、建学生/建任务报错引导去教室 head 配置。 */
  defaultModel?: { providerId?: string, modelId: string },
}
Response 201: { classroom: ClassroomEntity, headSessionId: string }
```

**事务**：建 classroom record + 建 head session（`academy-head_teacher:parent:main`，workspaceDir=`<DATA_DIR>/academy/<cid>/head-workspace/`，model 经 `resolveAcademySessionModel(appConfig, body.defaultModel, undefined)` fallback 链解析落盘——head session 模型持久化以避免 activate 时 env default 缺失）+ `classroom.headTeacherSessionId` 双向关联。

### 1.2 GET /academy/classroom — 列教室

```
GET /academy/classroom
Response 200: { items: ClassroomEntity[] }
```

### 1.3 GET /academy/classroom/:cid — 教室详情（含 students/tasks/datasets/graders 概览）

```
GET /academy/classroom/:cid
Response 200: { classroom, students: StudentEntity[], tasks: TrainingTaskEntity[], datasets, graders }
```

### 1.4 PATCH /academy/classroom/:cid — 改教室（name/logo/defaultModel）

```
PATCH /academy/classroom/:cid
Body: {
  name?: string,
  logo?: string,
  /** 教室级默认模型：null / 保留字 modelId = 清除（strip 不落盘）；具体非保留字 = 设置。 */
  defaultModel?: { providerId?: string, modelId: string } | null,
}
Response 200: ClassroomEntity
```

### 1.5 POST /academy/classroom/:cid/student — 创建学生

```
POST /academy/classroom/:cid/student
Body: { name: string, logo?: string }
Response 201: { student: StudentEntity, initialVersion: StudentVersionEntity }
```

**事务**：建 student record + 建 0.0 初始版本（formal, status='active', workspaceDir=`.../students/<sid>/versions/0.0/ws/`, AGENTS.md 空）+ `student.currentFormalVersionId = initialVersion.id`。

### 1.6 GET /academy/classroom/:cid/student — 列学生

```
GET /academy/classroom/:cid/student
Response 200: { items: StudentEntity[] }
```

### 1.7 GET /academy/classroom/:cid/student/:sid — 学生详情（含版本树）

```
GET /academy/classroom/:cid/student/:sid
Response 200: { student, versions: StudentVersionEntity[], tasks: TrainingTaskEntity[] }
```

> **[v0.0.219] response 加 `tasks`**（该学生的训练任务，由 `listTasksByClassroom(cid)` filter studentId 得）：使前端 `useStudentDetail` 自足检测 active task 驱动实时轮询（无需另调 classroom 聚合端点）。task DTO 含 §2.2 `baseVersionLabel` 反规范化字段。

### 1.8 GET /academy/classroom/:cid/student/:sid/version/:vid — 版本内容（五元组）

```
GET /academy/classroom/:cid/student/:sid/version/:vid
Response 200: {
  meta: StudentVersionEntity,
  content: { agentsMd: string, skills: SkillSummary[], memory: MemoryEntrySummary[], versionJson: VersionJson }
}
```

**`SkillSummary`（[v0.0.214] 定义补齐）**：skill 的载体是「一个目录 + 一个 SKILL.md + 任意附属文件」（权威源 `specs/tech/agent/skills/[P0]skill_definition.md §1/§2`），因此本字段不是目录名列表，而是**目录 + 文件树**：

```typescript
interface SkillSummary {
  /** skill 目录名（= .rocky/skills/<name>/） */
  name: string;
  /** SKILL.md frontmatter description；无 SKILL.md / 无该字段 → undefined（目录仍进列表，不跳过） */
  description?: string;
  /** 目录内文件总数（递归，只数 file 不数 dir） */
  fileCount: number;
  /** 目录内文件树（扁平数组，path 相对 skill 目录；同 06-skill.md §6.2 SkillFileNode 形状 + hash） */
  files: AcademySkillFileNode[];
}

interface AcademySkillFileNode {
  name: string;                 // 基名
  path: string;                 // 相对 skill 目录（如 SKILL.md、templates/a.yaml）——不外泄绝对路径
  type: 'file' | 'dir';
  size?: number;                // file 字节数
  /** file 内容哈希 = sha1(bytes) 前 12 hex；dir 无。用途：两版本 diff 判定「文件是否修改」 */
  hash?: string;
}
```

```json
{
  "meta": { "id": "01J…", "versionLabel": "1.0", "type": "formal", "workspaceDir": "/…/versions/1.0/ws" },
  "content": {
    "agentsMd": "# 小红书文案专家\n…",
    "skills": [
      {
        "name": "panorama-designer",
        "description": "全景图排版方法论",
        "fileCount": 3,
        "files": [
          { "name": "SKILL.md", "path": "SKILL.md", "type": "file", "size": 2130, "hash": "a1b2c3d4e5f6" },
          { "name": "templates", "path": "templates", "type": "dir" },
          { "name": "grid.yaml", "path": "templates/grid.yaml", "type": "file", "size": 512, "hash": "0f1e2d3c4b5a" },
          { "name": "logo.png", "path": "templates/logo.png", "type": "file", "size": 8422, "hash": "998877665544" }
        ]
      }
    ],
    "memory": [],
    "versionJson": { "versionLabel": "1.0", "model": { "providerId": "minimax", "modelId": "MiniMax-Text-01" } }
  }
}
```

> **`memory` [v0.0.219] 从恒 `[]` 升级为真实条目**：`resolveVersionContent` 扩读 `<workspaceDir>/.rocky/memory/` 下 md 文件，返 `MemoryEntrySummary[]`（`{ name: string; size: number; preview: string }`，preview = 文件前 ~200 字符）。缺目录返 `[]`（0.0 版本 graceful）。前端 Memory 卡显条目数 + 「查看」开 version memory modal（只读，对齐 chat-page memory modal 样式）。
>
> **`meta` [v0.0.219] 含 `adoptedFromProcessVersionId`**（`StudentVersionEntity` 字段，adoptToFormal 写入）：formal 由采纳产生时落源 process version id，UI 据此显「采纳自 v{label}」徽章；初始 0.0 / 旧 record 无此字段。
>
> **实现**：`app/server/src/academy/academy-version-dir.ts listVersionSkills(wsDir)`，复用 `skills/tree.ts buildFileTree`（文件树）+ `skills/resolver.ts parseSkillDir`（description）；hash 用 `node:crypto` sha1。memory 读侧同文件 `resolveVersionContent` 扩读 `.rocky/memory/`。

### 1.9 PATCH /academy/classroom/:cid/student/:sid/version/:vid — 编辑版本内容（formal 版本可编辑）

```
Body: { agentsMd?: string, versionJson?: Partial<VersionJson> }  // skills 文件经 §1.11，memory 待实现
Response 200: StudentVersionEntity
```

**约束**：formal 版本可编辑；process 版本只读（训练临时区）→ 409 `process_version_readonly`。

> **[v0.0.214] MUST NOT 用本端点写 skill 内容**：本端点走 `writeVersionDirFiles` 全量重写 AGENTS.md + version.json。曾有前端把 skill 目录名列表当 `agentsMd` 提交，导致 AGENTS.md 被覆盖为目录名列表（数据丢失）。skill 内单文件读写走 §1.11 专用端点。

### 1.10 POST /academy/classroom/:cid/student/:sid/version/:vid/session — 基于版本启动会话

```
POST .../version/:vid/session
Body: { title?: string }
Response 201: { sessionId: string }
```

**用途**：design.md §8.g「每个正式版学生可发起会话」。建一个 `academy-student:parent:main` session，workspaceDir = version.workspaceDir，subAgentConfig.tools = version.json.tools。

### 1.11 版本 skill 单文件读 / 写（[v0.0.214] 新增）

skill 文件树随 §1.8 一次性返回（`content.skills[].files`）；**单文件内容按需读**（progressive disclosure，同 `skill_definition.md §3` L1/L2 精神），formal 版本可写。

#### 1.11.1 GET .../version/:vid/skill/:name/file — 读单文件

```
GET /academy/classroom/:cid/student/:sid/version/:vid/skill/:name/file?path=<relPath>
```

- `:name` = skill 目录名；`?path=` = 相对 skill 目录的路径（必填，如 `SKILL.md` / `references/guide.py`）
- `200` · `{ path: string, content: string, truncated: boolean, binary: boolean }`
  - 文本：`content` = 全文（>256KB 截断 + `truncated=true`）
  - 二进制（图片等）：`content=''`、`binary=true`（前端显「不可预览」）
  - **响应 shape 与 `06-skill.md §7.2` 一致**（同一读原语 `app/server/src/skills/file-io.ts readSkillFile`，前端可共用解析）

#### 1.11.2 PATCH .../version/:vid/skill/:name/file — 写单文件（formal only）

```
PATCH /academy/classroom/:cid/student/:sid/version/:vid/skill/:name/file
Body: { path: string, content: string }
Response 200: { ok: true, path: string }
```

**约束（MUST）**：
1. **仅 formal 版本可写**；process 版本（训练临时区）→ 409 `process_version_readonly`（与 §1.9 同判定同错误码）。
2. **只覆写已存在的文本文件**——不创建新文件、不建目录、不删文件、不写二进制目标（本版无对应 UI，写权限面保持最小）。目标不存在 → 404。
3. **不经 `writeVersionDirFiles`**（那会全量重写 AGENTS.md + version.json，正是 §1.9 注中要堵的数据丢失形态）。

#### 1.11.3 错误码

| HTTP | code / error | 触发 |
|---|---|---|
| 400 | `invalid path` | 缺 `path`；`path` 越界（resolve 后非 skill 目录内）；`:name` 非法（走 `skills/resolver.ts isValidSkillName`：仅 kebab-case 且 ≤64 字符，故 `/`、`..`、空、大写均拒） |
| 400 | `invalid_input` | PATCH body 的 `content` 不是字符串 |
| 400 | `binary_not_writable` | PATCH 目标是二进制文件（utf8 覆写会损坏字节流，拒写） |
| 404 | `classroom_not_found` / `student_not_found` / `version_not_found` | 三层 id 任一不存在（复用 §1.8 的 `resolveVersion` 校验） |
| 404 | `skill_not_found` | skill 目录不存在于该版本工作区 |
| 404 | `Not Found` | 文件不存在（含 PATCH 目标不存在——不隐式创建） |
| 409 | `process_version_readonly` | PATCH 非 formal 版本 |

#### 1.11.4 为什么不复用 `GET /skill/:name/tree|file`（架构决策，勿回退）

| 维度 | 复用 `/skill/*`（否决） | 本节 academy 专属端点（采用） |
|---|---|---|
| workspace 锁定 | `handlers/skill.ts lookupScope` 在 workspace 未命中会**回落 app → builtin**，academy 会读到用户/内置 skill；须为该域加 strict 开关 | 目录由 server 从 `version.workspaceDir` 派生，回落路径**结构上不存在** |
| 路径泄漏 | 需前端把 `version.workspaceDir`（DATA_DIR 绝对路径）当 query 明文传，与 `06-skill §6.2`「path 相对 skillDir 防泄漏绝对路径」的设计意图相反 | URL 只含 cid/sid/vid + 相对 path |
| 域语义 | `/skill/*` 是「用户已安装 skill」域（enabled / governance / delete），版本资产无这些语义；写路径更无处安放 | 与 §1.8/§1.9 同域，formal/process 权限与三层 404 语义归位复用 |
| 请求数 | diff 需 2 + N×2 次 tree/file 往返 | 文件树随 §1.8 免费带回，diff 仍是 2 次请求 |

> **复用发生在原语层，不在路由层**：文件树复用 `skills/tree.ts buildFileTree`，读/写复用 `skills/file-io.ts`（由 `handlers/skill.ts handleFile` 抽出后两域共用，净去重）。

## 2. 训练任务

### 2.1 POST /academy/classroom/:cid/student/:sid/training-task — 发起训练

```
Body: {
  baseVersionId: string,
  mode: 'simple' | 'multi',
  optimizeStyle: 'learning' | 'training',
  directive: string,
  datasetId?: string,              // multi 必填
  graderId?: string,               // multi 必填
  maxTurns?: number                // 默认 5（multi）
}
Response 201: {
  task: TrainingTaskEntity,        // task.candidateVersionId 建任务时即就位（初始 candidate fork 自 base）
  coachSessionId: string,
  candidateVersionId: string,      // 初始 candidate version id（coach 正在编辑的候选）
  candidateWorkspaceDir: string,   // candidate workspace 绝对路径（coach edit 目标）
}
```

**语义**：等同 coach 用 `train-student action=start` 工具；HTTP 入口给 head session 前端调用（head session 内由用户对话触发也可走 LLM 工具）。两入口都调同一后端核心 `createTrainingTaskAndCoach`（`academy-training-core.ts`），消除原 head 工具 start 占位 coachSessionId 不建真实 coach 的偏离。

**事务**（核心 5 步——顺序是护栏）：① 校验（classroom/student/base formal/multi 必填 dataset+grader/同 student 无 running）+ 分配 taskSeq + gen tid → ② fork 初始 candidate（round=1 自 base）→ candidateVersionId + workspaceDir → ③ `resolveAcademySessionModel(appConfig, undefined, classroom.defaultModel)`（fallback classroom.defaultModel → 未配则 400 `model_not_configured`；**v0.0.230 去 app 默认兜底**——教室未配 defaultModel 时建任务明确报错引导去教室 head 配置，无应用层默认概念）+ createSession(coach, workspaceDir=candidate ws, trainingTaskId=tid) → ④ putTask(coachSessionId, candidateVersionId, temporaryBaselineVersionId=baseVersionId, status='pending') → ⑤ 读 base resolveVersionContent + 组装任务书 deliverTo(coach, buildTaskBookMessage) fire-and-forget（投递失败不阻塞返 201）。

**顺序约束**：先 gen tid 再 createSession 是为满足 validateSessionContext C5「coach parent ⇒ trainingTaskId 必填」；coach workspaceDir = 初始 candidate ws（修原 cwd 错位）。

### 2.2 GET /academy/training-task/:tid — 任务详情（含历史轮次）

```
Response 200: { task, turns: TrainingTurnEntity[], currentTurn?, baselineScore?, history: TurnSummary[] }
```

> **task DTO 含 `baseVersionLabel`**（v0.0.219，string，base 版本 versionLabel）：前端教室训练 tab / 任务卡 / 训练观察页无 versions 上下文，统一由后端 read 时 `getVersion(cid, task.baseVersionId).versionLabel` 反规范化（共享 helper `attachBaseVersionLabel` in `academy-training-task-shared.ts`），供前端拼任务名「v{baseMajor}.{taskSeq} 训练任务」（PRD §2.5）。**覆盖 4 handler**：`handleGetClassroom`（§1.3 tasks 数组）+ `handleCreateTask`（§2.1）+ `handleGetTask`（§2.2）+ `handleGetStudent`（§1.7 tasks 数组）。
>
> **task DTO 含 `pausedReason`**（v0.0.221）：status='paused' 时区分为何而停（enum: `maxturns`/`completed`/`stopped`/`earlystop`）；其他状态必为 undefined。前端据此判终态（maxturns 须 update_task 调大续训 vs 可 resume）。

### 2.3 POST /academy/training-task/:tid/revise — 推进一轮（等同 coach 调 revise）

```
Body: {}
Response 200: TurnResult
```

> 注：通常 coach session 内通过 LLM 工具调用 `manage-task action=revise`；此 HTTP 端点给前端调试/手动推进用，调 `engine.reviseCandidate`（coach 主导修订语义）。

### 2.4 POST /academy/training-task/:tid/adopt — 采纳旁路（v0.0.221 新增）

```
Body: { versionId: string }   // 必填，指定哪个 process 版归档
Response 200: { newFormalVersionId: string, newLabel: string, newWorkspaceDir: string }
```

**语义**：把任意 process 版本复制为新 formal（按 seq 找下一个空正式号，如 2.0→3.0），**不改 task 状态**（旁路），**可重复调**（同一 task 产多个 formal：2.0/3.0/4.0...）。同步 `student.currentFormalVersionId` 指针 + 写 `adoptedFromProcessVersionId` 溯源 + patchVersionJsonLabel 同步 workspace 内 version.json versionLabel。等同 coach 调 `manage-task action=adopt`。

### 2.5 POST /academy/training-task/:tid/pause — 暂停任务（v0.0.221）

```
Body: { reason?: 'stopped' | 'completed' | 'earlystop' }   // 缺省 'stopped'
Response 200: ack
```

**语义**：task → status='paused' + pausedReason；不改 candidate/baseline 指针。等同 coach 调 `manage-task action=pause`。

### 2.6 POST /academy/training-task/:tid/resume — 续训（v0.0.221）

```
Body: {}
Response 200: ack
```

**约束**：status === 'paused' 且 pausedReason !== 'maxturns' 才可 resume；否则 409 `task_at_maxturns`（提示先 update-task 调大 maxTurns）或 `invalid_task_state`。等同 coach 调 `manage-task action=resume`。

### 2.7 POST /academy/training-task/:tid/update-task — 调整 maxTurns/directive（v0.0.221 新增）

```
Body: { maxTurns?: number, directive?: string }   // 至少一字段
Response 200: ack
```

**语义**：head 监督级 patch（仅 maxTurns + directive 两字段，其他字段 400 `invalid_input`）。**主要用途**：让 coach 续训越过原 maxTurns 上限（task 到顶 reason=maxturns 时，update_task 调大 maxTurns 才能 resume）；次要用途：调整 directive 给 advisory 建议（不改 task 状态）。

### 2.8 POST /academy/training-task/:tid/inject-directive — 训练中注入指导（design.md §6）

```
Body: { directive: string }
Response 200: ack
```

**语义**：把指导消息透传给 coach（deliverTo）+ append 进 task.directive（不替换原 directive；多段拼接）。

## 3. 教室资产（dataset / grader）

### 3.1 POST /academy/classroom/:cid/dataset — 建数据集

```
Body: { name: string, description?: string, items: DatasetItem[] }
Response 201: DatasetEntity
```

### 3.2 GET /academy/classroom/:cid/dataset — 列表

### 3.3 GET /academy/classroom/:cid/dataset/:did — 详情（含 items）

### 3.4 PATCH /academy/classroom/:cid/dataset/:did — 改（name/description/items 全量替换）

### 3.5 DELETE /academy/classroom/:cid/dataset/:did — 软删

### 3.6-3.10 grader（结构同 dataset）

```
POST   /academy/classroom/:cid/grader
GET    /academy/classroom/:cid/grader
GET    /academy/classroom/:cid/grader/:gid
PATCH  /academy/classroom/:cid/grader/:gid
DELETE /academy/classroom/:cid/grader/:gid
```

## 4. 教室会话

### 4.1 GET /academy/session?classroomId=:cid — 教室下所有 session（head/coach/学生）

> **未实现**：本端点早期草案设计但 v0.0.210 未落代码。**前端实际走 `GET /session?biz=academy`**（biz 过滤）+ 客户端按 `academyClassroomId` / `academyVersionId` 字段二次过滤兜底（`listAcademySessions` in `app/web/src/lib/academy-api.ts`）。后续版本如需服务端 classroomId 过滤再补。

### 4.2 GET /session/:id/messages — 只读观察（任意 session）

复用现有 `GET /session/:id/messages`；只读模式由 `GET /session/:id/chrome` 的 `readOnly` 字段驱动（`derivation==='subagent'` → true，见 `04a-session-chrome.md §3.1`；前端 `SectionChatSession` 另有 `readOnly` prop 双保险——design.md §8 「任意 session 只读观察」通用模式）。

## 5. squad derive（与 squad 端点集成）

### 5.1 POST /squad/:squadId/member — 扩 mode='derive_academy'

```
Body: {
  mode: 'derive_academy',
  academySource: { classroomId, studentId, versionId },
  name: string,
  intro?: string,
  workStyle?: string,
  ...
}
Response 201: { member, sessionId }   // 同现有 11a §2.1
```

> 扩展现有 `POST /squad/:squadId/member`（specs/api/overall/11a-squad-endpoints.md §2.1），不改 URL。

## 6. 训练引擎 → coach inbox（a2a 消息，**非** SSE 事件）

> **design 双引擎实现**：引擎状态变化通过 `deliverTo` 推 a2a Message 到 coach session 的 inbox（消息 `sender.source='system'`，`kind='academy-training-engine'`，`metadata.needReply=true`）。coach 的 agent_loop 处理消息帧表现为 `message_enqueued` 事件（topic=`agent_loop`，group=`session_id:{coachSid}_amt:main`）。**不存在 `training.*` SSE 事件类型**——早期 architect 草案误写为 SSE 事件，已对齐 design.md 双引擎原意（a2a 投递，与现有 heartbeat/cron 同模式）。

投递场景（详见 `specs/tech/academy/[P0]training_engine.md §7`）：

| 触发 | 投递目标 | 消息内容 |
|---|---|---|
| start_task 完成 | coach | "新任务 #N 你接管：directive = X，base = Y" |
| revise 完成 | coach | "turn N 完成，决策：improve/regress；improve 时附新 candidate workspaceDir；到顶/早停时 task 已 paused，文案提示 update_task 调大 maxTurns 再 resume"（不再 propose）|
| pause / resume / adopt 完成 | coach | "task #N 已 paused/resumed/adopted"；adopt 附新 formal versionId + label + 提示「task 仍在产，可继续迭代」（强调旁路）|
| 断点续跑唤醒 | coach | "任务 #N 上次中断于 round K，请评估"；旧值 migration（done/aborted/rejected/awaiting_confirm→paused+reason）后投递 |

**前端 UI 兜底**（无 SSE 订阅）：useTrainingTask 4s 轮询 `GET /academy/training-task/:tid`（pending/running 状态）+ coach 消息流驱动 softReload（`onMessagesChange→taskHook.softReload`，不 nullify ctx 避免子树 unmount/remount 循环）。

> **[v0.0.219] 实时性扩展（前端轮询兜底，SSE 后置）**：除 useTrainingTask 单任务轮询外，`useStudentDetail` / `useClassroomDetail` 在检测到 active task（running/pending/awaiting_confirm）时起 ~5s timer 周期 reload（复用 useTrainingTask polling 模式：startTimer + onTick mutateCtx 软刷新，不堆叠 timer），让运行中训练 fork 的 round2+ 过程版实时涌现，而非 freeze 到用户离开后 re-fetch。**后端 training.\* SSE 仍未落地**（spec 声明但代码缺），后置版本补；本版前端轮询兜底（PRD §2.3）。

## 7. 错误码总览

| 场景 | code | HTTP |
|---|---|---|
| 创建教室 name 缺失 | `invalid_input` | 400 |
| 创建教室缺 defaultModel（创建即必填，v0.0.230 起） | `model_not_configured` | 400 |
| classroomId 不存在 | `classroom_not_found` | 404 |
| studentId 不存在 / 不属于教室 | `student_not_found` | 404 |
| versionId 不存在 | `version_not_found` | 404 |
| 任务 baseVersionId 非 formal | `invalid_base_version` | 400 |
| multi 模式缺 datasetId/graderId | `missing_evaluation_config` | 400 |
| 任务状态不允许该 action（如 maxturns 时 resume / 非 paused 时 resume） | `invalid_task_state` | 409 |
| resume 时 pausedReason=maxturns（硬终态，须先 update-task 调大 maxTurns） | `task_at_maxturns` | 409 |
| update-task body 非对象 / maxTurns+directive 都缺 / 含其他字段 | `invalid_input` | 400 |
| adopt 时 versionId 非 process 类型 | `invalid_version_type` | 400 |
| 同 student 已有 running 任务 | `task_already_running` | 409 |
| derive_academy 源 version 非 formal | `invalid_academy_source` | 400 |
| 学生 version.json.model 缺 providerId | `version_needs_model` | 400 |
| 班主任/教练模型未配置（fallback 链全不命中） | `model_not_configured` | 400 |
| LLM 调用 429/529/503（sample/grade） | `rate_limited` | 503（HTTP 端）/工具层返错（LLM） |
| [v0.0.214] 版本工作区无该 skill 目录 | `skill_not_found` | 404 |
| [v0.0.214] skill 文件 path 缺失/越界，或 skill name 非法 | `invalid path` | 400 |
| [v0.0.214] 写 skill 文件 / 编辑版本时目标是 process 版本 | `process_version_readonly` | 409 |
| [v0.0.214] 写 skill 文件时目标是二进制文件（拒 utf8 覆写） | `binary_not_writable` | 400 |
| [v0.0.214] 写 skill 文件 body 非对象 / `content` 非字符串 | `invalid_input` | 400 |

> **v0.0.221 已删除的错误码**：`nothing_to_adopt`（原 accept 时无可采纳的 process 版抛；adopt 旁路接受任意 process 版本，无此场景）。

### 7.0 manage-classroom action 矩阵（v0.0.221 head 专属 20 action）

head 通过 `manage-classroom` 工具操纵教室资产 + 学生 CRUD + 任务监督（20 action，详见 `[P0]session_kind_extension.md §7`）：

| 分组 | action | 语义 |
|---|---|---|
| 教室资产（原 9） | `install_skill`/`list_skills`/`uninstall_skill`/`create_dataset`/`list_datasets`/`get_dataset`/`update_dataset`/`create_grader`/`list_graders`/`get_grader`/`update_grader`/`delete_dataset`/`delete_grader` | dataset/grader/skill CRUD |
| 学生 CRUD（原 manage-student 7） | `list_students`/`get_student`/`create_student`/`update_student`/`delete_student`/`list_versions`/`get_version` | 学生管理 + 版本五元组读取 |
| 任务监督（新 4） | `start_task`/`list_tasks`/`get_task`/`update_task` | 发起训练 + 看板 + 单 task 详情 + patch maxTurns/directive |

> 原三工具（train-student / manage-student / manage-classroom）→ 两工具（`manage-task`[coach 专属] + `manage-classroom`[head 专属，扩 20]）；`manage-student` 工具删除（9 action 并入 manage-classroom，helper 函数留作 import）。

## 7.1 路由分发顺序（dispatchAcademyRoutes）

`/academy/*` 路由组按**最长前缀优先**分发（具体 pattern 先于 generic 前缀；详见 `app/server/src/routes/academy-routes.ts` 头注释不变量）：

1. `/academy/training-task/*` → handleTrainingTaskRoute（任务详情 / revise / adopt / pause / resume / update-task / inject-directive）
2. `/academy/classroom/:cid/student/:sid/training-task` → handleTrainingTaskRoute（发起训练 §2.1）
3. `/academy/classroom/:cid/student/:sid/version/*` → handleStudentRoute（版本内容/编辑/启动会话 §1.8-1.10；**[v0.0.214]** `/version/:vid/skill/:name/file` 亦由此承接，在 handleStudentRoute 内二次分发到 `handlers/academy-student-skill.ts handleVersionSkillRoute`——该 pattern MUST 排在 `/version/([^/]+)$` 精确匹配**之前**，否则落兜底 404）
4. `/academy/classroom/:cid/student/:sid` → handleStudentRoute（学生详情 §1.7）
5. `/academy/classroom/:cid/{dataset,grader}/*` → handleAssetsRoute（教室资产 CRUD §3）
6. `/academy/classroom[/:cid[/student]]` 浅层 → handleClassroomRoute（兜底前缀；更深层的未识别路径也进这里由 handler 返 404）

> dispatch 级 UT 32 case 锁定（`academy-routes-dispatch.test.ts`）；R1 review 修复 Critical bug——曾因规则 1 generic `/academy/classroom/` 吞深层路径致 6 组端点全 404。

## 8. 边界

| 管 | 不管 |
|---|---|
| URL/method/body/response schema | 本文 ✅ |
| task/turn record schema | `specs/tech/academy/[P0]data_model.md` |
| 状态机实现 | `specs/tech/academy/[P0]training_engine.md` |
| manage-task / manage-classroom 工具 action 对应 | `specs/tech/academy/[P0]train_student_tool.md` + `[P0]session_kind_extension.md §7` |
| 路由注册 | `app/server/src/routes/academy-routes.ts`（新建） |
