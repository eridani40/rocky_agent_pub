/**
 * session-store-core-impl — SessionStore 的 session 生命周期核心方法实现
 *
 * 纯 move 自 session-store.ts（v0.0.156 结构性拆分 Round 2 — code review 打回 facade
 * 仍 568 行超阈值后追加拆分）。函数体 100% copy-paste，签名 + 内部逻辑不变。class 内
 * 方法改为单行委托到本文件 standalone 函数，与 session-store-{messages,usage,children}
 * -impl.ts 完全同款模式（第 4 次复用）。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.4-4.5 + INV-S-3
 *
 * 方法组（grep 已核实）：
 *   - createSession / getSession / getSessionKind / updateSession / listSessions / deleteSession
 *   - fallbackCascadeDelete（deleteSession 内部私有 helper，非公开 API，未导出，随 deleteSession 一并 move）
 *   - stripEnvelope（纯工具函数；被 session-store-usage-impl.ts 等经 store.stripEnvelope(...) 调用，
 *     facade 保留同名委托方法维持该调用点不变）
 *
 * INV-S-3：class 公开 API 100% 等价（bootstrap/handlers/services 零改）。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径；store 作入参。
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SchemaDef } from '../persistence/schema-types';
import type { BizType, Role, Derivation, SessionContext } from '@app/shared';
import { SessionKind, validateSessionKind, validateSessionContext, SessionKindValidationError } from '@app/shared';
import type { SessionKind as SessionKindType } from '@app/shared';
import { SessionSchema, MessageSchema, SummarySchema, RunSchema } from './schema_defs';
import type { SessionRecord } from './schema_defs';
import type { SessionStore } from './session-store';
import type { Session, CreateSessionInput } from './session-store-types';
import { SessionNotFoundError, toSession, normalizeKeyArray } from './session-store-converters';

/** 创建 session */
export async function sessionStoreCreateSession(
  store: SessionStore,
  input: CreateSessionInput,
): Promise<Session> {
  // biz/role/derivation 身份权威源（缺省兜底默认值）
  const biz: BizType = input.biz ?? 'playground';
  const role: Role = input.role ?? 'rocky';
  // v0.0.204：derivation main→parent 改名（schema enumValues 同步）
  const derivation: Derivation = input.derivation ?? 'parent';
  // v0.0.204：两层校验（shape K1-K5 + context C1-C3）；enabled 门由 T2 profile loader 守
  // v0.0.210：C4-C7 加 academy context（classroomId/studentId/versionId/trainingTaskId）
  validateSessionKind({ biz, role, derivation });
  validateSessionContext(
    { biz, role, derivation },
    {
      ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.squadId !== undefined ? { squadId: input.squadId } : {}),
      ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
      ...(input.classroomId !== undefined ? { classroomId: input.classroomId } : {}),
      ...(input.studentId !== undefined ? { studentId: input.studentId } : {}),
      ...(input.versionId !== undefined ? { versionId: input.versionId } : {}),
      ...(input.trainingTaskId !== undefined ? { trainingTaskId: input.trainingTaskId } : {}),
    },
  );
  // v0.0.204 T2-B5：enabled 门（STP §8）——仅 main-run 类型（derivation='parent'）走门。
  //   profile 必须存在且 enabled!==false，否则 fail fast（ValidationError）；summary/consolidate
  //   runKind 不经此门（forked 旁路 run，caller 经 sideRun 入口，不走 createSession）。
  //   缺省 loader（UT fixture / dev misconfig）→ 门跳过；生产路径 bootstrap 必注。
  //   未启用类型可不建 profile yaml 文件——本门主动跳过。
  if (derivation === 'parent' && store.sessionTypeProfileLoader) {
    const mainKind = `${biz}-${role}:${derivation}:main`;
    const loader = store.sessionTypeProfileLoader;
    if (!loader.has(mainKind)) {
      throw new SessionKindValidationError(
        `createSession: main-run 类型未登记 profile (${mainKind}) — biz/role/derivation 组合无对应 yaml`,
      );
    }
    if (loader.profile(mainKind).enabled === false) {
      throw new SessionKindValidationError(
        `createSession: main-run 类型已禁用 (${mainKind}, profile.enabled=false)`,
      );
    }
  }
  const rec: SessionRecord = {
    id: input.id,
    title: input.title,
    status: input.status ?? 'active',
    ...(input.contextWindowUsage !== undefined
      ? { contextWindowUsage: input.contextWindowUsage as unknown }
      : {}),
    // 手动选 model 持久字段（可选）
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    // 子 agent parent session id（递归 sub 上报用）
    ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
    // 身份权威字段
    biz,
    role,
    derivation,
    // 其他字段直写
    ...(input.subAgentTemplateType !== undefined ? { subAgentTemplateType: input.subAgentTemplateType } : {}),
    ...(input.origin !== undefined ? { origin: input.origin as unknown } : {}),
    // subagent 派生配置（eff 持久化；buildSessionConfigFromDeps 覆盖默认）
    ...(input.subAgentConfig !== undefined
      ? { subAgentConfig: input.subAgentConfig as unknown }
      : {}),
    // squadId/memberId（optional）
    ...(input.squadId !== undefined ? { squadId: input.squadId } : {}),
    ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
    // [v0.0.210] academy 4 字段持久化（仅 biz='academy' 的 session 填；schema 已声明 optional）
    ...(input.classroomId !== undefined ? { academyClassroomId: input.classroomId } : {}),
    ...(input.studentId !== undefined ? { academyStudentId: input.studentId } : {}),
    ...(input.versionId !== undefined ? { academyVersionId: input.versionId } : {}),
    ...(input.trainingTaskId !== undefined ? { academyTrainingTaskId: input.trainingTaskId } : {}),
    // workspaceDir（caller 按 session_workspace.md §3 建好传入；不传时落 undefined，由 lazy 修复补建）
    ...(input.workspaceDir !== undefined ? { workspaceDir: input.workspaceDir } : {}),
    // [v0.0.148] effort/approvalMode 持久化（新建可选带；不传 → toSession lazy 缺省 default/normal）
    //   alwaysApprovedKeys 不进 create（新建无「已批准」语义，toSession 缺省 []）
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode } : {}),
    // unread 默认 false（explicit-bool 模型，spec session_state.md §6）
    unread: false,
    // titled 强制 false（AI 起名 CAS gate，spec session_store.md §2）
    //   新建 session 一律未命名（title 仍是默认占位「新会话」）。CreateSessionInput 不暴露 titled
    //   字段（caller 不应传）；此处显式写 false 防御 caller 透传。置 true 仅两个 timing（AI 起名
    //   应用 / 用户改名 PUT body.title），均经 updateSession 走 CAS gate。
    titled: false,
  };
  // putAsync 串行化（spec §6.1 [wait]）：同 parent 并发建 child 会争 children index
  const stored = await store.crud.putAsync(SessionSchema, rec);
  // 维护 children 正向索引（subagent 创建即挂到 parent；lazy 已建才维护）
  store.childrenIndex.onCreated(
    (rec as SessionRecord & { parentSessionId?: string }).parentSessionId,
    rec.id,
  );
  return toSession(stored);
}

/** 读单个 session；不存在返 null */
export async function sessionStoreGetSession(
  store: SessionStore,
  sessionId: string,
): Promise<Session | null> {
  const got = store.crud.get(SessionSchema, sessionId);
  return got ? toSession(got) : null;
}

/**
 * 读 session 记录 → 构造 slim SessionKind 对象（v0.0.204：只投影身份 4 字段，实例 ID 迁 getSessionContext）。
 * 参考: specs/tech/agent/session/[P0]session_kind.md §4
 *
 * 直接读 biz/role/derivation 字段；runKind 缺省 'main'（record 无此字段；run 装配点补真值覆盖）。
 * 无读兼容层（旧 shape 读时 fail，明显错误不静默吞）。
 *
 * @param sessionId 目标 session id
 * @throws SessionNotFoundError session 不存在
 */
export async function sessionStoreGetSessionKind(
  store: SessionStore,
  sessionId: string,
): Promise<SessionKindType> {
  const rec = store.crud.get(SessionSchema, sessionId);
  if (!rec) throw new SessionNotFoundError(sessionId);
  return new SessionKind({
    biz: rec.biz,
    role: rec.role,
    derivation: rec.derivation,
    // runKind 不落盘——session 投影缺省 'main'；run 装配入口（activate/buildSideRun）覆盖真值
    runKind: 'main',
  });
}

/**
 * 读 session 记录 → 构造 SessionContext（6 实例 ID 投影，v0.0.204 新增；v0.0.210 加 academy 4 字段）。
 * 与 getSessionKind 同构造点配对产出；kind + context 分离承载。
 *
 * @param sessionId 目标 session id
 * @throws SessionNotFoundError session 不存在
 */
export async function sessionStoreGetSessionContext(
  store: SessionStore,
  sessionId: string,
): Promise<SessionContext> {
  const rec = store.crud.get(SessionSchema, sessionId);
  if (!rec) throw new SessionNotFoundError(sessionId);
  return {
    ...(rec.squadId !== undefined ? { squadId: rec.squadId } : {}),
    ...(rec.memberId !== undefined ? { memberId: rec.memberId } : {}),
    ...(rec.parentSessionId !== undefined ? { parentSessionId: rec.parentSessionId } : {}),
    // [v0.0.210] academy 4 字段（record.academyXxx → context 去前缀；C4-C7 校验保证 academy session 必填）
    ...(rec.academyClassroomId !== undefined ? { classroomId: rec.academyClassroomId as string } : {}),
    ...(rec.academyStudentId !== undefined ? { studentId: rec.academyStudentId as string } : {}),
    ...(rec.academyVersionId !== undefined ? { versionId: rec.academyVersionId as string } : {}),
    ...(rec.academyTrainingTaskId !== undefined ? { trainingTaskId: rec.academyTrainingTaskId as string } : {}),
  };
}

/**
 * 部分更新 session（title/status/contextWindowUsage + providerId/modelId + titled
 *   + effort/approvalMode/alwaysApprovedKeys + pinned）。
 * 显式 undefined 不修改；null 清空（仅 model 字段）。
 *
 * spread existing 保留运行态字段（state/running/currentRunId）后再覆盖 patch 字段，
 * 防止 updateContextWindowUsage 等调用覆盖丢失运行态（markRunning/markInterrupting 写入）。
 * titled 字段（AI 起名 CAS gate / 用户改名同步置 true，spec session_store.md §2
 *   + auto_naming/[P0]auto_naming_service.md §3/§6）走 `=== true` 规范化（对齐 toSession）。
 *
 * [v0.0.148] effort/approvalMode 部分更新语义（undefined → 保留 existing）。
 *   alwaysApprovedKeys 走 read-modify-write 去重 merge（Set 语义，非覆盖式写）：
 *   patch 提供的 keys 与 existing 合并去重；ApprovalManager.addAlwaysApprovedKey 走此路径。
 *
 * [v0.0.231] pinned（置顶标记）部分更新语义同上。**pinned-only patch 不推进 updatedAt**
 *   （置顶是纯标记操作，不算对话活动——用户裁决 2026-08-01）：判定按「提供的字段
 *   （非 undefined）⊆ {pinned}」，经 PutOptions.preserveUpdatedAt 写（version 仍 +1）；
 *   含任何非 pinned 字段（title/effort 等）仍现状推进。判定看「提供的字段」而非
 *   「patch 对象 key 全集」，防 `{pinned, title:undefined}` 误判。
 */
export async function sessionStoreUpdateSession(
  store: SessionStore,
  sessionId: string,
  patch: Partial<
    Pick<
      Session,
      | 'title'
      | 'status'
      | 'contextWindowUsage'
      | 'providerId'
      | 'modelId'
      | 'titled'
      | 'effort'
      | 'approvalMode'
      | 'alwaysApprovedKeys'
      | 'pinned'
    >
  >,
): Promise<void> {
  const e = store.crud.get(SessionSchema, sessionId);
  if (!e) throw new SessionNotFoundError(sessionId);
  const cw = patch.contextWindowUsage ?? e.contextWindowUsage;
  const pid = patch.providerId !== undefined ? patch.providerId : e.providerId;
  const mid = patch.modelId !== undefined ? patch.modelId : e.modelId;
  // titled：patch 提供则规范化为 boolean（=== true），否则保留 existing
  const titledBool =
    patch.titled !== undefined ? patch.titled === true : (e as { titled?: unknown }).titled === true;
  // [v0.0.148] effort/approvalMode：patch 提供 → 覆盖；undefined → 保留 existing
  const effortVal = patch.effort !== undefined ? patch.effort : (e as { effort?: unknown }).effort;
  const approvalModeVal =
    patch.approvalMode !== undefined
      ? patch.approvalMode
      : (e as { approvalMode?: unknown }).approvalMode;
  // [v0.0.148] alwaysApprovedKeys read-modify-write 去重 merge（Set 语义）：
  //   patch 提供 → 与 existing 合并去重；undefined → 保留 existing 原值
  const existingKeys = normalizeKeyArray((e as { alwaysApprovedKeys?: unknown }).alwaysApprovedKeys);
  const mergedKeys =
    patch.alwaysApprovedKeys !== undefined
      ? Array.from(new Set([...existingKeys, ...patch.alwaysApprovedKeys]))
      : existingKeys;
  // [v0.0.231] pinned：patch 提供则规范化为 boolean（=== true），否则保留 existing（lazy 默认）
  const pinnedVal = patch.pinned !== undefined ? patch.pinned === true : e.pinned;
  const rec: SessionRecord = {
    // spread existing 保留运行态字段（state/running/currentRunId）
    ...(e as unknown as SessionRecord),
    id: e.id,
    title: patch.title !== undefined ? patch.title : e.title,
    status: patch.status !== undefined ? patch.status : e.status,
    // titled（写入规范化为 boolean；spec §2 lazy 默认 false）
    titled: titledBool,
    ...(cw !== undefined ? { contextWindowUsage: cw as unknown } : {}),
    ...(pid !== undefined && pid !== null ? { providerId: pid } : {}),
    ...(mid !== undefined && mid !== null ? { modelId: mid } : {}),
    // [v0.0.148] effort/approvalMode（undefined 不加字段，保留 existing spread 值）
    ...(effortVal !== undefined ? { effort: effortVal as SessionRecord['effort'] } : {}),
    ...(approvalModeVal !== undefined
      ? { approvalMode: approvalModeVal as SessionRecord['approvalMode'] }
      : {}),
    // [v0.0.148] alwaysApprovedKeys（去重 merge 后的完整数组；always 写，[] 也是合法值）
    alwaysApprovedKeys: mergedKeys,
    // [v0.0.231] pinned（undefined 不加字段，保留 existing spread 值；写时规范化 boolean）
    ...(pinnedVal !== undefined ? { pinned: pinnedVal === true } : {}),
  };
  // 剥信封字段（put 不允许 record 自带 createdAt/updatedAt/version）
  const { createdAt: _ca, updatedAt: _ua, version: _v, ...rest } = rec as Record<string, unknown>;
  void _ca; void _ua; void _v;
  // [v0.0.231] pinned-only patch → preserveUpdatedAt（用户裁决：置顶是纯标记不刷新活跃时间）。
  //   判定按「提供的字段（非 undefined）⊆ {pinned}」；空 patch（无提供字段）走现状推进。
  const providedKeys = (Object.keys(patch) as (keyof typeof patch)[]).filter(
    (k) => patch[k] !== undefined,
  );
  const isPinnedOnly = providedKeys.length > 0 && providedKeys.every((k) => k === 'pinned');
  // putAsync 串行化（spec §6.1 [wait]）：config 字段 read-modify-write 竞态
  await store.crud.putAsync(
    SessionSchema,
    rest as SessionRecord,
    isPinnedOnly ? { preserveUpdatedAt: true } : undefined,
  );
}

/**
 * 列出全部 session，按 updatedAt desc。
 * biz/role 过滤参数（spec session_biztype.md §3 隔离规则）：
 *   - biz 缺省/未指定 → 返全部（handler 决定缺省 playground）
 *   - biz 显式传值 → 仅返该分区 session；无 biz 字段的历史 session 按 playground 归类
 *   - role 显式传值 → 仅返该角色 session；无 role 字段的历史 session 视为 'rocky'
 *     （channel /lists 用：listStudioLeaders = listSessions({biz:'studio',role:'leader'})）
 */
export async function sessionStoreListSessions(
  store: SessionStore,
  opts?: { biz?: BizType; role?: Role },
): Promise<Session[]> {
  const list = store.crud.query(SessionSchema, { order: 'createdAtDesc' });
  const all = list.map(toSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // 无 biz 字段的历史 session 视为 playground（spec session_biztype.md §1 lazy 默认）
  const wantBiz = opts?.biz;
  const filteredBiz = wantBiz === undefined
    ? all
    : all.filter((s) => (s.biz ?? 'playground') === wantBiz);
  // 无 role 字段的历史 session 视为 'rocky'（与 biz 兜底同款 lazy 默认）
  const wantRole = opts?.role;
  if (wantRole === undefined) return filteredBiz;
  return filteredBiz.filter((s) => (s.role ?? 'rocky') === wantRole);
}

/** 无 fsRoot 时的级联删回退（逐 schema 逐条删；用于 sqlite/非 fs engine），deleteSession 内部私有 helper */
async function fallbackCascadeDelete(store: SessionStore, sessionId: string): Promise<void> {
  // cascade 内逐条 deleteAsync 串行 await（同 path 串行；
  // 不同 record 保守按原顺序 await，避免段文件 tmp 互相覆盖）
  const delAll = async (schema: SchemaDef) => {
    const list = store.crud.query(schema, { shardKey: sessionId });
    for (const r of list) await store.crud.deleteAsync(schema, r.id as string, sessionId);
  };
  await delAll(MessageSchema);
  await delAll(SummarySchema);
  await delAll(RunSchema);
}

/**
 * 删除 session + 级联删 message/summary/run。
 * 级联策略：先删 session 自身（session/<id>.json），再 rm -rf sessions/<sid>/
 * （含 transcript/summary/runs 三子目录）。无 fsRoot 时回退到逐条删。
 *
 * 末尾调注入的 onSessionDestroyed 回调（cron 注销用）。
 *   fs cascade（rm -rf sessions/<sid>/）已删 cron.json 文件；回调主要做 engine.unregister
 *   （清内存 job）。回调注入式，避免 session-store → scheduling → session-store 循环依赖
 *   （spec [P1]cron_subsystem.md §8）。
 */
export async function sessionStoreDeleteSession(
  store: SessionStore,
  sessionId: string,
): Promise<void> {
  // 先读 record（拿 parentSessionId 维护 childrenIndex），再 delete
  const rec = store.crud.get(SessionSchema, sessionId) as
    | (SessionRecord & { parentSessionId?: string })
    | null;
  // deleteAsync 串行化（spec §6.1 [wait]）：HTTP clear 须确认完成
  await store.crud.deleteAsync(SessionSchema, sessionId);
  store.childrenIndex.onDeleted(sessionId, rec?.parentSessionId);
  if (store.fsRoot) {
    const sessionDir = join(store.fsRoot, 'sessions', sessionId);
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  } else {
    await fallbackCascadeDelete(store, sessionId);
  }
  // session 销毁回调（cron jobs engine.unregister + cron.json 清理；注入式避循环依赖）
  // fs cascade 已删 cron.json 文件，回调内 cronAdapter.removeAllJobs 为 no-op（idempotent 安全）
  await store.onSessionDestroyed?.(sessionId);
}

/** CrudStore.put 禁 record 自带信封字段（createdAt/updatedAt/version）—— 此函数剥除 */
export function sessionStoreStripEnvelope<T extends Record<string, unknown>>(rec: T): T {
  const { createdAt, updatedAt, version, ...rest } = rec as unknown as {
    createdAt?: unknown; updatedAt?: unknown; version?: unknown;
  };
  void createdAt; void updatedAt; void version;
  return rest as T;
}
