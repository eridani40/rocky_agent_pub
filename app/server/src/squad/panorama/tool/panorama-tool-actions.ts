/**
 * panorama 工具 schema 面 action 实现（define/get_schema/events）+ 共享 helper.
 * 参考: specs/tech/squad/[P1]panorama_tools.md §2
 * 数据面 action（create/update/transition/delete/query）在 panorama-tool-data-actions.ts（单文件 ≤300 行）.
 * 不碰 dsl/validation/migration/store 内部逻辑（已 verified 引擎，只调公开接口）.
 * store 每次 action call 新建（无状态文件 IO）；lastWriteMessageId 从 rtc.currentMessageId 取；source=agent.
 */
import type { ToolInput, ToolRunResult } from '../../../tools/types';
import { errorResult, textResult } from '../../../tools/types';
import type { AgentToolRuntimeContext } from '../../../agent/tools/runtime-context';
import { PanoramaEntityStore } from '../store/panorama_store';
import { parseDsl } from '../dsl/parser';
import { validateSchema } from '../validation';
import { applyMigration } from '../migration/apply_migration';
import {
  BreakingChangeRequiresApprovalError, MigrationMismatchError, MigrationPostValidationError,
} from '../migration/types';
import type { MigrationPlan } from '../migration/types';
import { emitPanoramaEvent } from '../http/sse';
import { ensureSystemEntities, injectSystemEntities } from '../builtin';
import type { PanoramaSchema } from '../dsl/types';
// 读 board.yaml 序列化用 yaml stringify（store 写盘已用，此处读复渲染给 LLM）
import { stringify as serializeYaml } from 'yaml';

/** 校验引擎 StoreLike 适配器：getInstance 返 null（store 返 undefined） */
export function storeLike(s: PanoramaEntityStore): {
  getInstance(e: string, i: string): Record<string, unknown> | null;
  listInstances(e: string): Record<string, unknown>[];
  hasId(e: string, i: string): boolean;
} {
  return { getInstance: (e, i) => s.getInstance(e, i) ?? null, listInstances: (e) => s.listInstances(e), hasId: (e, i) => s.hasId(e, i) };
}

/** panorama 8 action 全集（panorama_tools §2） */
export const PANORAMA_ACTIONS = [
  'define', 'get_schema', 'create', 'update', 'transition', 'delete', 'query', 'events',
] as const;
type PanoramaAction = (typeof PANORAMA_ACTIONS)[number];

/** 类型守卫：action 字串是否 ∈ panorama action 集 */
export function isPanoramaAction(action: string): action is PanoramaAction {
  return (PANORAMA_ACTIONS as readonly string[]).includes(action);
}

/** define 属 schema 面（权限最高：仅 leader/user；mate forbidden） */
export function isSchemaAction(action: string): boolean {
  return action === 'define';
}

/** 取 messageId（lastWriteMessageId 来源，caller 不直传，从 rtc.currentMessageId 自动取） */
export function msgId(rtc: AgentToolRuntimeContext): string | undefined {
  return rtc.currentMessageId;
}

/** 构造 store（panorama_dir = squads/{squadId}/panorama） */
export function store(rtc: AgentToolRuntimeContext, dataDir: string): PanoramaEntityStore {
  return new PanoramaEntityStore({ root: dataDir, squadId: rtc.selfSquadId! });
}

/**
 * 读 squad schema（lazy migration chokepoint，panorama_builtin §3）.
 * 替代各 action 直读 store.readBoard()：task entity 经 ensureSystemEntities 恒在，空板也不返 null.
 */
export function readSquadSchema(rtc: AgentToolRuntimeContext, dataDir: string): PanoramaSchema {
  return ensureSystemEntities(store(rtc, dataDir));
}

// ── 校验结果 → ToolRunResult ──────────────────────────────

export function validationFailed(v: { errors: { code: string; message: string; path?: string; layer?: string; suggestion?: string }[] }): ToolRunResult {
  return errorResult(JSON.stringify({ ok: false, errors: v.errors }));
}

export function okJson(data: unknown): ToolRunResult {
  return textResult(JSON.stringify(data));
}

// ── 1. define（schema 面，panorama_tools §2.1） ──────────

export async function runDefine(
  input: ToolInput, rtc: AgentToolRuntimeContext, dataDir: string,
): Promise<ToolRunResult> {
  const dsl = typeof input.dsl === 'string' ? input.dsl : '';
  if (dsl.length === 0) {
    return errorResult('panorama.define: dsl (YAML 全文) is required');
  }
  const s = store(rtc, dataDir);
  // oldSchema 用 raw readBoard（不触发 lazy migration）：保持 dryRun 纯无副作用.
  // newSchema 注入 canonical task 后，diff 看到 task 是 entity_added（非 deleted）→ 非破坏性.
  const oldSchema = s.readBoard();
  const messageId = msgId(rtc);

  // 带 migration/approved = 声明迁移意图 → L4 数据安全交给 migration 引擎裁决（deferDataSafety），
  // 否则 L4 会先把 applyMigration 堵死（v0.0.189 生产实证：agent 交 migration 也永远 400）
  const hasMigrationIntent = input.migration !== undefined || input.approved === true;
  // 校验四层（Layer1 短路 → 2-3 收集 → 4 数据安全，有 oldSchema+store 才跑 L4）
  const result = validateSchema(dsl, {
    oldSchema: oldSchema ?? undefined, store: storeLike(s), deferDataSafety: hasMigrationIntent,
  });
  if (!result.ok) return validationFailed(result);

  // dryRun = 只校验不落盘，返 warnings（panorama_tools §2.1 dryRun）
  if (input.dryRun === true) {
    return okJson({ ok: true, warnings: result.warnings });
  }

  // 落盘前需解析出 schema 供 migration 引擎用（validateSchema 内部 parse 不外露，此处独立 parse）
  const parsed = parseDsl(dsl);
  if (!parsed.ok) return validationFailed({ errors: parsed.errors });

  // 时序关键（panorama_builtin §3 决策 5）：validate 已先跑（让 checkSystemEntityImmutable 看到
  // leader 原始提交拒字段漂移）→ pass 后 inject canonical task 进 newSchema → applyMigration diff
  // 看到 task 是 entity_added（oldSchema 无 task）/ 无 change（oldSchema 已含 canonical task），
  // 永不误判 entity_deleted:task → 非破坏性.dryRun 路径不注入（不落盘，仅返回 warnings）.
  injectSystemEntities(parsed.schema);

  const migration = input.migration as { operations: MigrationPlan['operations'] } | undefined;
  try {
    const res = applyMigration(s, {
      oldSchema: oldSchema ?? parsed.schema,
      newSchema: parsed.schema,
      plan: migration ? { operations: migration.operations } : undefined,
      approved: input.approved === true,
      messageId: messageId ?? null,
    });
    // 落盘成功 → emit schema_update（panorama_http.md §4.3）
    if (rtc.panoramaBus) {
      emitPanoramaEvent(rtc.panoramaBus, rtc.selfSquadId!, { type: 'panorama_schema_update', squadId: rtc.selfSquadId!, seq: res.seq });
    }
    return okJson({ ok: true });
  } catch (e) {
    if (e instanceof BreakingChangeRequiresApprovalError) {
      return errorResult(JSON.stringify({ code: 'panorama_breaking_change_requires_approval' }));
    }
    if (e instanceof MigrationMismatchError) {
      return errorResult(JSON.stringify({ code: 'panorama_migration_mismatch', message: e.message }));
    }
    if (e instanceof MigrationPostValidationError) {
      // 迁移后实例校验不过（已回滚）——把违规明细喂回 agent 修 migration（如 narrow_enum 缺 mapping）
      return errorResult(JSON.stringify({ code: 'panorama_migration_postcheck', message: e.message, violations: e.violations.slice(0, 10) }));
    }
    return errorResult(`panorama.define: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 2. get_schema（读，全员，panorama_tools §2.2） ────────

export async function runGetSchema(
  rtc: AgentToolRuntimeContext, dataDir: string,
): Promise<ToolRunResult> {
  // ensureSystemEntities 触发 lazy migration：task entity 恒在（首访问 squad 建表）
  const schema = readSquadSchema(rtc, dataDir);
  // 序列化返（YAML 含 task entity/view——agent 可见，修认知 bug，panorama_tools §2.2）
  return okJson({ dsl: serializeYaml(schema) });
}

// ── 7. events（读，panorama_tools §2.7） ─────────────────

export async function runEvents(
  input: ToolInput, rtc: AgentToolRuntimeContext, dataDir: string,
): Promise<ToolRunResult> {
  const since = typeof input.since === 'number' ? input.since : 0;
  const limit = typeof input.limit === 'number' ? input.limit : 50;
  const events = store(rtc, dataDir).readEvents(since, limit);
  return okJson({ events });
}
