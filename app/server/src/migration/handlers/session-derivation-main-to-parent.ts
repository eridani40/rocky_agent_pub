/**
 * session-derivation-main-to-parent handler — 存量 session record derivation 'main' → 'parent'。
 * 参考: specs/tech/version_logs/v0.0.204/change_plan.md 行#27（schema enumValues main→parent 改名）
 *       specs/tech/migration/[P0]migration_manager.md（handler 契约 + 失败由 manager catch）
 *
 * 背景：v0.0.204 把 Derivation 枚举值 'main' 改名 'parent'（schema_defs/session.ts:132
 *   enumValues 从 ['main','subagent'] 改为 ['parent','subagent']）。未配 migration 时，存量
 *   session record 里 derivation:'main' 在任意 put（update / 状态机推进 / config 写）时 schema
 *   校验 `[field=derivation] 值越界` 崩溃，packaged electron 启动后第一个 session 操作即炸。
 *   dev 全绿测不到（只在真跑撞——本 handler 是 load-bearing，不跑则老用户首操即崩）。
 *
 * 幂等（record 级 marker）：仅当 record.derivation === 'main' 才改写为 'parent'；非 'main'
 *   （'parent' / 'subagent'）→ 不进写入列表。二次运行 filter 自然得空集 → 静默 no-op。
 *
 * 非破坏：只改 derivation 字段；其他字段（id/title/state/usage/role/biz/...）经 rest spread
 *   原样保留。信封字段（createdAt/updatedAt/version）剥除后由 FsCrudStore.put 重新计算
 *   （createdAt 保留 / updatedAt=now / version+1）。
 *
 * 走 CrudStore.putAsync 正规入口（禁裸 fs），复用 FsCrudStore 的信封 + 原子写 + schema 校验
 * （写 'parent' 经 schema 校验合法通过——这是本迁移的关键安全性）。
 *
 * 为什么不用 SessionStore facade：facade 构造需 sessionTypeProfileLoader / childrenIndex /
 * stateMachine / statusBus 等重依赖；本迁移只需读全量 session record + putAsync 写回一字段，
 * 直挂 CompositeStore + FsCrudStore（entity='session'）到 dataDir 即可。
 */
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionSchema } from '../../agent/schema_defs';
import type { SessionRecord } from '../../agent/schema_defs';
import type { MigrationHandlerContext } from '../ledger';

/**
 * CrudStore.put 禁 record 自带信封字段（createdAt/updatedAt/version）—— 此处剥除。
 * 与 session-clear-op.ts / session-state-machine.ts 同语义（模块隔离，各自私有）。
 */
function stripEnvelope<T extends Record<string, unknown>>(rec: T): T {
  const { createdAt, updatedAt, version, ...rest } = rec as unknown as {
    createdAt?: unknown;
    updatedAt?: unknown;
    version?: unknown;
  };
  void createdAt;
  void updatedAt;
  void version;
  return rest as T;
}

/**
 * 存量 session record derivation: 'main' → 'parent' 迁移 handler。
 * @param ctx MigrationManager 注入的上下文（dataDir 已 resolveDataDir 展开）
 */
export const sessionDerivationMainToParentMigration = async (
  ctx: MigrationHandlerContext,
): Promise<void> => {
  // 直挂 CompositeStore + FsCrudStore（entity='session'）——不走 SessionStore facade（重依赖）。
  // dataDir 由 manager 走 resolveDataDir 展开成绝对路径（packaged cwd=/ 下必须绝对）。
  const crud = new CompositeStore().mount('session', new FsCrudStore({ root: ctx.dataDir }));

  // 读全量 session record（query 不做 schema 校验，所以 'main' 老 record 能读出）。
  // 注：TS 窄化 derivation 为 'parent'|'subagent'（新 schema 字面量），但运行时 'main' 是
  // 老 record 真实值（schema 改名前的合法落盘）——须经 unknown 宽化读字段值做 legacy 判定。
  const list = crud.query(SessionSchema, { order: 'createdAtDesc' });
  // 幂等快路径：filter derivation==='main' —— 'parent'/'subagent' record 自然被过滤
  const legacies = list.filter(
    (r) => (r as unknown as { derivation?: string }).derivation === 'main',
  );
  if (legacies.length === 0) return; // 全量 no-op（无 main record）

  // 逐条改 derivation: 'main' → 'parent' 写回（putAsync 串行；写 'parent' 经 schema 校验合法通过）
  // 只动 derivation 字段，其他字段（含 id/title/state/usage/parentSessionId/...）rest spread 原样保留
  for (const rec of legacies) {
    const widened = rec as unknown as Record<string, unknown>;
    await crud.putAsync(
      SessionSchema,
      stripEnvelope({ ...widened, derivation: 'parent' }) as SessionRecord,
    );
  }
};
