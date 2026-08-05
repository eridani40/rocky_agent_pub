/**
 * clean-squad-summary-model-default handler 单测 — squad record 存量 summary 字段清理
 * 参考: specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md §H
 *       specs/tech/migration/[P0]migration_manager.md（handler 契约）
 *       specs/tech/squad/[P1]data_model.md §1.1（SquadSchema — v0.0.158 已删两 summary 字段）
 *
 * 覆盖：
 *   - 数据存在（某 squad 含 summaryModelDefault 或 providerId）→ 跑后字段被 unset、其他字段保留
 *   - 数据不存在（无 squad / 全无 summary 字段）→ 无 putSquad 调用（no-op）
 *   - 幂等：二次运行进 no-op 分支
 *   - 混合：同批 squad 部分含字段部分无 → 只处理有字段的
 *   - 非破坏：modelDefault / charter / memberIds / 信封重算等其他字段完整保留
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 * 用真实 SquadStore + tmp dataDir（不 mock）——handler 走 CrudStore 真实读写路径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config-service';
import { SquadStore } from '../../../stores/squad-store';
import { ulid } from '../../../config/ulid';
import { cleanSquadSummaryModelDefaultMigration } from '../clean-squad-summary-model-default';
import type { MigrationHandlerContext } from '../../ledger';

let tmpDataDir: string;
let appConfig: AppConfigService;
let squadStore: SquadStore;
let ctx: MigrationHandlerContext;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'clean-squad-summary-test-'));
  appConfig = new AppConfigService({ root: tmpDataDir });
  squadStore = new SquadStore({ root: tmpDataDir });
  ctx = { dataDir: tmpDataDir, appConfig };
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * 建一条 squad record（含所有 SquadSchema required 字段），可选带 summary 字段。
 * summary 字段虽从 SquadSchema 删除，但 validateRecord 只校验已定义字段（不拒收 extra），
 * 故存量 record 携带这两字段可通过 putSquad 落盘 —— 模拟 v0.0.158 之前的存量。
 */
async function seedSquad(opts: {
  name?: string;
  modelDefault?: string;
  modelDefaultProviderId?: string;
  summaryModelDefault?: string;
  summaryModelDefaultProviderId?: string;
}): Promise<string> {
  const id = ulid();
  const leaderId = ulid();
  const rec: Record<string, unknown> = {
    id,
    name: opts.name ?? 'alpha',
    description: '',
    modelDefault: opts.modelDefault ?? 'MiniMax-M3',
    leaderId,
    memberIds: [leaderId],
    squadChatSessionId: ulid(),
    charter: { goals: '', workingStyle: '', collaboration: '', escalation: '' },
    enableHeartBeat: false,
    timezone: 'UTC',
  };
  if (opts.modelDefaultProviderId !== undefined) rec.modelDefaultProviderId = opts.modelDefaultProviderId;
  if (opts.summaryModelDefault !== undefined) rec.summaryModelDefault = opts.summaryModelDefault;
  if (opts.summaryModelDefaultProviderId !== undefined) {
    rec.summaryModelDefaultProviderId = opts.summaryModelDefaultProviderId;
  }
  await squadStore.putSquad(rec as Parameters<typeof squadStore.putSquad>[0]);
  return id;
}

describe('cleanSquadSummaryModelDefaultMigration — 数据存在（含 summary 字段）', () => {
  it('squad 含 summaryModelDefault + summaryModelDefaultProviderId 两字段 → 跑后两字段 unset', async () => {
    const sid = await seedSquad({
      summaryModelDefault: 'gpt-4o-mini',
      summaryModelDefaultProviderId: 'openai',
    });

    await cleanSquadSummaryModelDefaultMigration(ctx);

    const after = await squadStore.getSquad(sid);
    expect(after).toBeDefined();
    const raw = after as unknown as Record<string, unknown>;
    expect('summaryModelDefault' in raw).toBe(false);
    expect('summaryModelDefaultProviderId' in raw).toBe(false);
  });

  it('squad 只含 summaryModelDefault（无 providerId 字段）→ 跑后字段 unset', async () => {
    const sid = await seedSquad({ summaryModelDefault: 'model-x' });

    await cleanSquadSummaryModelDefaultMigration(ctx);

    const after = await squadStore.getSquad(sid);
    const raw = after as unknown as Record<string, unknown>;
    expect('summaryModelDefault' in raw).toBe(false);
    expect('summaryModelDefaultProviderId' in raw).toBe(false);
  });

  it('squad 只含 summaryModelDefaultProviderId（无 modelId 字段）→ 跑后字段 unset', async () => {
    const sid = await seedSquad({ summaryModelDefaultProviderId: 'provider-y' });

    await cleanSquadSummaryModelDefaultMigration(ctx);

    const after = await squadStore.getSquad(sid);
    const raw = after as unknown as Record<string, unknown>;
    expect('summaryModelDefault' in raw).toBe(false);
    expect('summaryModelDefaultProviderId' in raw).toBe(false);
  });

  it('非破坏：其他字段（name/modelDefault/modelDefaultProviderId/charter/memberIds/leaderId 等）完整保留', async () => {
    const sid = await seedSquad({
      name: 'beta-team',
      modelDefault: 'MiniMax-M3',
      modelDefaultProviderId: 'minimax',
      summaryModelDefault: 'gpt-4o-mini',
      summaryModelDefaultProviderId: 'openai',
    });
    const before = await squadStore.getSquad(sid);
    const beforeRaw = before as unknown as Record<string, unknown>;

    await cleanSquadSummaryModelDefaultMigration(ctx);

    const after = await squadStore.getSquad(sid);
    const afterRaw = after as unknown as Record<string, unknown>;
    expect(afterRaw.name).toBe('beta-team');
    expect(afterRaw.modelDefault).toBe('MiniMax-M3');
    expect(afterRaw.modelDefaultProviderId).toBe('minimax');
    expect(afterRaw.leaderId).toBe(beforeRaw.leaderId);
    expect(afterRaw.memberIds).toEqual(beforeRaw.memberIds);
    expect(afterRaw.squadChatSessionId).toBe(beforeRaw.squadChatSessionId);
    expect(afterRaw.charter).toEqual(beforeRaw.charter);
    expect(afterRaw.enableHeartBeat).toBe(false);
    expect(afterRaw.timezone).toBe('UTC');
    // 信封字段：version 应 +1（handler 走 upsert）；createdAt 保留；updatedAt 推进
    expect(afterRaw.version).toBe((beforeRaw.version as number) + 1);
    expect(afterRaw.createdAt).toBe(beforeRaw.createdAt);
  });

  it('多 squad 混合：部分含 summary + 部分不含 → 只处理有字段的', async () => {
    const sidDirty = await seedSquad({
      name: 'dirty',
      summaryModelDefault: 'gpt-4o-mini',
    });
    const sidClean = await seedSquad({ name: 'clean' });
    const cleanBefore = await squadStore.getSquad(sidClean);
    const cleanBeforeVersion = (cleanBefore as unknown as { version: number }).version;

    await cleanSquadSummaryModelDefaultMigration(ctx);

    // dirty squad：summary 字段清除，version +1
    const dirtyAfter = await squadStore.getSquad(sidDirty);
    const dirtyRaw = dirtyAfter as unknown as Record<string, unknown>;
    expect('summaryModelDefault' in dirtyRaw).toBe(false);

    // clean squad：无变化（无 putSquad 调用），version 保持
    const cleanAfter = await squadStore.getSquad(sidClean);
    const cleanAfterVersion = (cleanAfter as unknown as { version: number }).version;
    expect(cleanAfterVersion).toBe(cleanBeforeVersion);
  });
});

describe('cleanSquadSummaryModelDefaultMigration — 数据不存在 / no-op', () => {
  it('无 squad → 跑完 no-op（不抛错）', async () => {
    // 不 seed 任何 squad —— listSquads 返空数组
    await expect(cleanSquadSummaryModelDefaultMigration(ctx)).resolves.toBeUndefined();
    const squads = await squadStore.listSquads();
    expect(squads).toEqual([]);
  });

  it('所有 squad 都无 summary 字段（已是干净状态）→ 无 putSquad 调用，version 全部保持', async () => {
    const sid1 = await seedSquad({ name: 'a' });
    const sid2 = await seedSquad({ name: 'b' });
    const before1Version = (await squadStore.getSquad(sid1) as unknown as { version: number }).version;
    const before2Version = (await squadStore.getSquad(sid2) as unknown as { version: number }).version;

    await cleanSquadSummaryModelDefaultMigration(ctx);

    const after1Version = (await squadStore.getSquad(sid1) as unknown as { version: number }).version;
    const after2Version = (await squadStore.getSquad(sid2) as unknown as { version: number }).version;
    expect(after1Version).toBe(before1Version);
    expect(after2Version).toBe(before2Version);
  });
});

describe('cleanSquadSummaryModelDefaultMigration — 幂等', () => {
  it('二次运行（首次已清）→ 第二次 no-op（version 不再推进）', async () => {
    const sid = await seedSquad({
      summaryModelDefault: 'gpt-4o-mini',
      summaryModelDefaultProviderId: 'openai',
    });

    // 首次：字段清除 + version 推进
    await cleanSquadSummaryModelDefaultMigration(ctx);
    const afterFirst = await squadStore.getSquad(sid);
    const afterFirstRaw = afterFirst as unknown as Record<string, unknown>;
    expect('summaryModelDefault' in afterFirstRaw).toBe(false);
    const versionAfterFirst = afterFirstRaw.version as number;

    // 二次：应 no-op，version 保持
    await cleanSquadSummaryModelDefaultMigration(ctx);
    const afterSecond = await squadStore.getSquad(sid);
    const afterSecondRaw = afterSecond as unknown as Record<string, unknown>;
    expect(afterSecondRaw.version).toBe(versionAfterFirst);
    expect('summaryModelDefault' in afterSecondRaw).toBe(false);
  });
});
