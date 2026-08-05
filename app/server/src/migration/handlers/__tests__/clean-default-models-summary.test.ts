/**
 * clean-default-models-summary handler 单测 — app_config default_models 存量 summary 清理
 * 参考: specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md §H
 *       specs/tech/migration/[P0]migration_manager.md（handler 契约）
 *
 * 覆盖：
 *   - 数据存在（record 含 chat + summary）→ 跑后 chat 保留、summary 删除、set 被调
 *   - 数据不存在（record 缺 / 无 summary key）→ set 未被调用（no-op）
 *   - 幂等：二次运行进 no-op 分支（不 set）
 *   - 非破坏：其他键（如 chat + 未来扩展的未知键）原样保留
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config-service';
import { cleanDefaultModelsSummaryMigration } from '../clean-default-models-summary';
import type { MigrationHandlerContext } from '../../ledger';

let tmpDataDir: string;
let appConfig: AppConfigService;
let ctx: MigrationHandlerContext;

const GROUP = 'default_models';
const KEY = 'default';

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'clean-default-models-summary-test-'));
  appConfig = new AppConfigService({ root: tmpDataDir });
  ctx = { dataDir: tmpDataDir, appConfig };
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('cleanDefaultModelsSummaryMigration — 数据存在（含 summary key）', () => {
  it('record 含 chat + summary → 跑后 summary 删除、chat 保留、set 被调', async () => {
    appConfig.set(GROUP, KEY, {
      chat: { modelId: 'MiniMax-M3', providerId: 'minimax' },
      summary: { modelId: 'gpt-4o-mini', providerId: 'openai' },
    });
    const setSpy = vi.spyOn(appConfig, 'set');

    await cleanDefaultModelsSummaryMigration(ctx);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const after = appConfig.get(GROUP, KEY) as Record<string, unknown>;
    expect(after).toBeDefined();
    expect(after.chat).toEqual({ modelId: 'MiniMax-M3', providerId: 'minimax' });
    expect('summary' in after).toBe(false);
  });

  it('非破坏：未知扩展字段（future 兼容键）原样保留', async () => {
    appConfig.set(GROUP, KEY, {
      chat: { modelId: 'A', providerId: 'p1' },
      summary: { modelId: 'B', providerId: 'p2' },
      futureKey: 'reserved',
    });

    await cleanDefaultModelsSummaryMigration(ctx);

    const after = appConfig.get(GROUP, KEY) as Record<string, unknown>;
    expect(after.chat).toEqual({ modelId: 'A', providerId: 'p1' });
    expect(after.futureKey).toBe('reserved');
    expect('summary' in after).toBe(false);
  });

  it('record 只含 summary（无 chat）→ 跑后 summary 删除，record 变空对象', async () => {
    appConfig.set(GROUP, KEY, {
      summary: { modelId: 'X', providerId: 'Y' },
    });

    await cleanDefaultModelsSummaryMigration(ctx);

    const after = appConfig.get(GROUP, KEY) as Record<string, unknown>;
    expect(after).toBeDefined();
    expect('summary' in after).toBe(false);
    expect(Object.keys(after)).toEqual([]);
  });
});

describe('cleanDefaultModelsSummaryMigration — 数据不存在 / no-op', () => {
  it('record 完全不存在 → set 未调用', async () => {
    const setSpy = vi.spyOn(appConfig, 'set');
    await cleanDefaultModelsSummaryMigration(ctx);
    expect(setSpy).not.toHaveBeenCalled();
    expect(appConfig.get(GROUP, KEY)).toBeUndefined();
  });

  it('record 存在但无 summary key（已是干净状态）→ set 未调用（幂等）', async () => {
    appConfig.set(GROUP, KEY, {
      chat: { modelId: 'MiniMax-M3', providerId: 'minimax' },
    });
    const setSpy = vi.spyOn(appConfig, 'set');

    await cleanDefaultModelsSummaryMigration(ctx);

    expect(setSpy).not.toHaveBeenCalled();
    const after = appConfig.get(GROUP, KEY) as Record<string, unknown>;
    expect(after.chat).toEqual({ modelId: 'MiniMax-M3', providerId: 'minimax' });
  });

  it('record 为空对象 → 无 summary key → no-op（不 set）', async () => {
    appConfig.set(GROUP, KEY, {});
    const setSpy = vi.spyOn(appConfig, 'set');

    await cleanDefaultModelsSummaryMigration(ctx);

    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('cleanDefaultModelsSummaryMigration — 幂等', () => {
  it('二次运行（首次已清）→ 第二次 no-op（不 set）', async () => {
    appConfig.set(GROUP, KEY, {
      chat: { modelId: 'A', providerId: 'p' },
      summary: { modelId: 'B', providerId: 'p' },
    });

    // 首次 run：清 summary、set 被调
    await cleanDefaultModelsSummaryMigration(ctx);
    const afterFirst = appConfig.get(GROUP, KEY) as Record<string, unknown>;
    expect('summary' in afterFirst).toBe(false);

    // 二次 run：应 no-op
    const setSpy = vi.spyOn(appConfig, 'set');
    await cleanDefaultModelsSummaryMigration(ctx);
    expect(setSpy).not.toHaveBeenCalled();

    // 数据形状不变
    const afterSecond = appConfig.get(GROUP, KEY) as Record<string, unknown>;
    expect(afterSecond).toEqual(afterFirst);
  });
});
