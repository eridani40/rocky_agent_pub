/**
 * squad-dissolve — team 硬删除（解散）编排。
 * 参考: specs/tech/version_logs/v0.0.111/change_plan.md 块②（dissolveSquad 编排）
 *       states/v0.0.111.workitem_visibility/team-delete-research.md（硬删执行顺序权威）
 *       specs/tech/version_logs/v0.0.192.delete_cleanup/change_plan.md（保留产出 + 级联删子孙）
 *
 * 核心正确性约束（MUST，顺序不可颠倒）：teardown 必须先于删数据，否则内存里的 heartbeat
 * job / cron / 在跑 loop 会在数据删掉后仍照点 fire、继续烧钱（"潜伏调度"——本需求要根除的东西）。
 *   ① disposeSquad —— 停调度/watcher/在跑 run（per-squad 运行时 teardown）
 *   ② deleteSession（各会话）—— 级联 rm sessions/{sid}/（含 cron.json）+ onSessionDestroyed 注销内存 cron
 *   ③ deleteSquad —— 删 squad record
 *   ④ deleteSquadAdministrativeSubpaths —— 只删办公室管理性子路径（保工作产出）
 *
 * deps 全部通过参数注入（结构端口），便于 UT mock + 记录调用序验证顺序。
 */
import { deleteSquadAdministrativeSubpaths } from '../stores/squad-store';

/** dissolveSquad 结构端口依赖（UT 注入 mock；生产由 handler 组装真实 store/runtime） */
export interface DissolveSquadDeps {
  squadId: string;
  /** per-squad 运行时 teardown（SquadRuntime.disposeSquad） */
  squadRuntime: { disposeSquad(squadId: string): Promise<void> };
  /** 删 session（级联 rm 目录 + cron + onSessionDestroyed）+ 按 squadId 平铺查 session */
  sessionStore: {
    deleteSession(sessionId: string): Promise<void>;
    listSessionsBySquad(squadId: string): Promise<string[]>;
  };
  /** 删 squad record */
  squadStore: {
    deleteSquad(squadId: string): Promise<boolean>;
  };
  /** data_dir（已由 config 展开为绝对路径；禁字面拼 `~`，BUG-004 打包护栏） */
  dataDir: string;
}

/**
 * 硬删（解散）一个 squad：teardown → 删各会话 → 删 record → 删管理性子路径。
 * 顺序严格不可颠倒（见文件头约束）。
 *
 * 会话快照时序：listSessionsBySquad 必须在删任何 session 前调用（删后 listSessions 不返）；
 * 该方法不依赖 squad record 存活（按 Session.squadId 字段扫 crud.query 全量），但删 record 后
 * session 仍存——故 step②→③ 顺序宽松（仍保持「teardown→删 session→删 record」原序）。
 */
export async function dissolveSquad(deps: DissolveSquadDeps): Promise<void> {
  const { squadId, squadRuntime, sessionStore, squadStore, dataDir } = deps;

  // 先快照全部 squad session（含 spawn children，按 squadId 平铺查）——必须在删任何 session 前读
  const sessionIds = await sessionStore.listSessionsBySquad(squadId);

  // ① 运行时 teardown（停调度，防潜伏——必须先于删数据）
  await squadRuntime.disposeSquad(squadId);
  // ② 删各会话（级联 rm sessions/{sid}/ 含 cron.json + onSessionDestroyed 注销内存 cron）
  for (const sid of sessionIds) {
    await sessionStore.deleteSession(sid);
  }
  // ③ 删 squad record
  await squadStore.deleteSquad(squadId);
  // ④ 删办公室管理性子路径（保留 workspaces/outputs/reports/board 用户工作产出）
  deleteSquadAdministrativeSubpaths(dataDir, squadId);
}
