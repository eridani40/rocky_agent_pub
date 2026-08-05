/**
 * squad-rocky-dir migration handler 单测
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A3
 *
 * 覆盖：`<dataDir>/squads/<sid>/.rocky_squad/` → `.rocky/` 全量平移
 *   ① memory.md 拆 per-entry（原戳保留）② state/ 复制 ③ skills/ 复制 ④ 空后删旧目录
 *   - 幂等（无 .rocky_squad skip / 二次运行 no-op）
 *   - 无法解析 memory.md 保留不丢数据（.rocky_squad 残留保留 + warn）
 *   - 未知残留文件保留 .rocky_squad（不丢数据）
 *
 * 文件系统隔离：os.tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config-service';
import { parseEntryFile } from '../../../memory/memory-dir-store';
import { squadRockyDirMigration } from '../squad-rocky-dir';
import type { MigrationHandlerContext } from '../../ledger';

let tmpRoot: string;
let ctx: MigrationHandlerContext;
let oldRoot: string;
let newRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-mig-squadrocky-'));
  ctx = { dataDir: tmpRoot, appConfig: new AppConfigService({ root: tmpRoot }) };
  oldRoot = join(tmpRoot, 'squads', 'sq1', '.rocky_squad');
  newRoot = join(tmpRoot, 'squads', 'sq1', '.rocky');
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const LEGACY_MEMORY =
  '---\nname: rule-1\nintro: team rule\nmetadata:\n  type: project\nsource: agent\nupdatedAt: 2026-03-01T00:00:00.000Z\nevolvable: true\n---\nrule body\n';

/** 造完整 .rocky_squad 旧结构（memory.md + state/ + skills/） */
function seedOldLayout(): void {
  mkdirSync(join(oldRoot, 'state'), { recursive: true });
  writeFileSync(join(oldRoot, 'memory.md'), LEGACY_MEMORY, 'utf8');
  writeFileSync(join(oldRoot, 'state', 'scheduler.json'), '{"enabled":true}', 'utf8');
  writeFileSync(join(oldRoot, 'state', 'history.jsonl'), '{"t":1}\n', 'utf8');
  mkdirSync(join(oldRoot, 'skills', 'team-skill'), { recursive: true });
  writeFileSync(join(oldRoot, 'skills', 'team-skill', 'SKILL.md'), '---\nname: team-skill\n---\ndoit\n', 'utf8');
}

describe('squad-rocky-dir migration', () => {
  it('memory.md 拆 per-entry + state/skills 平移 + 删空 .rocky_squad', async () => {
    seedOldLayout();
    await squadRockyDirMigration(ctx);

    // ① memory per-entry（原戳保留）
    const e = parseEntryFile(readFileSync(join(newRoot, 'memory', 'rule-1.md'), 'utf8'))!;
    expect(e.intro).toBe('team rule');
    expect(e.source).toBe('agent');
    expect(e.updatedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(e.body).toBe('rule body');
    // ② state 平移
    expect(readFileSync(join(newRoot, 'state', 'scheduler.json'), 'utf8')).toBe('{"enabled":true}');
    expect(readFileSync(join(newRoot, 'state', 'history.jsonl'), 'utf8')).toBe('{"t":1}\n');
    // ③ skills 平移
    expect(existsSync(join(newRoot, 'skills', 'team-skill', 'SKILL.md'))).toBe(true);
    // ④ 旧目录全删
    expect(existsSync(oldRoot)).toBe(false);
  });

  it('幂等：无 .rocky_squad skip；二次运行 no-op', async () => {
    await squadRockyDirMigration(ctx); // 空 → no-op
    seedOldLayout();
    await squadRockyDirMigration(ctx);
    expect(existsSync(join(newRoot, 'memory', 'rule-1.md'))).toBe(true);
    await squadRockyDirMigration(ctx); // 二次
    expect(existsSync(join(newRoot, 'memory', 'rule-1.md'))).toBe(true);
    expect(existsSync(oldRoot)).toBe(false);
  });

  it('部分段缺失（只有 state）→ 只迁 state', async () => {
    mkdirSync(join(oldRoot, 'state'), { recursive: true });
    writeFileSync(join(oldRoot, 'state', 'budget-state.json'), '{}', 'utf8');
    await squadRockyDirMigration(ctx);
    expect(existsSync(join(newRoot, 'state', 'budget-state.json'))).toBe(true);
    expect(existsSync(oldRoot)).toBe(false);
  });

  it('memory.md 无法解析 → 保留旧文件 + .rocky_squad 残留不删（不丢数据）', async () => {
    mkdirSync(oldRoot, { recursive: true });
    writeFileSync(join(oldRoot, 'memory.md'), 'totally not frontmatter', 'utf8');
    await squadRockyDirMigration(ctx);
    expect(existsSync(join(oldRoot, 'memory.md'))).toBe(true);
    expect(existsSync(oldRoot)).toBe(true);
  });

  it('未知残留文件 → 三段迁完但 .rocky_squad 保留', async () => {
    seedOldLayout();
    writeFileSync(join(oldRoot, 'mystery.bin'), 'x', 'utf8');
    await squadRockyDirMigration(ctx);
    expect(existsSync(join(newRoot, 'memory', 'rule-1.md'))).toBe(true);
    expect(existsSync(join(oldRoot, 'mystery.bin'))).toBe(true);
    expect(existsSync(join(oldRoot, 'memory.md'))).toBe(false); // 已迁段删除
  });

  it('多 squad 遍历互不影响', async () => {
    seedOldLayout(); // sq1
    const old2 = join(tmpRoot, 'squads', 'sq2', '.rocky_squad');
    mkdirSync(join(old2, 'state'), { recursive: true });
    writeFileSync(join(old2, 'state', 'scheduler.json'), '{"enabled":false}', 'utf8');
    await squadRockyDirMigration(ctx);
    expect(existsSync(join(tmpRoot, 'squads', 'sq1', '.rocky', 'memory', 'rule-1.md'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'squads', 'sq2', '.rocky', 'state', 'scheduler.json'))).toBe(true);
  });
});
