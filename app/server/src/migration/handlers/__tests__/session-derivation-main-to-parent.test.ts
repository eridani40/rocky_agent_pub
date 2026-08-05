/**
 * session-derivation-main-to-parent handler 单测 — 存量 session record derivation 改名
 * 参考: specs/tech/version_logs/v0.0.204/change_plan.md 行#27（schema enumValues main→parent 改名）
 *       specs/tech/migration/[P0]migration_manager.md（handler 契约：幂等 MUST / 非破坏 MUST）
 *
 * 覆盖：
 *   - case 1: derivation='main' → 迁移后变 'parent'（非破坏：其他字段保留）
 *   - case 2: 'parent' / 'subagent' → 不动（幂等 no-op）
 *   - case 3: 混合（部分 main 部分 parent/subagent）→ 只改 main 的，非 main 不动
 *   - case 4: 二次运行 → 全 no-op（信封 version 不再自增）
 *   - case 5: 空数据 → no-op 不抛错
 *
 * 关键测试设计：'main' 值在当前 schema 下已非法（enumValues=['parent','subagent']），不能经
 *   crud.put 写入（schema 校验会拒绝）；本 UT 用 fs.writeFileSync 直接落盘 legacy record
 *   模拟老版本写入的数据（绕过 schema 校验），再跑迁移 handler 验证行为。
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync；真实 CrudStore 读写（不 mock）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '../../../config/ulid';
import { CompositeStore } from '../../../persistence/composite';
import { FsCrudStore } from '../../../persistence/fs-store';
import { SessionSchema } from '../../../agent/schema_defs';
import type { SessionRecord } from '../../../agent/schema_defs';
import { AppConfigService } from '../../../config/app-config-service';
import { sessionDerivationMainToParentMigration } from '../session-derivation-main-to-parent';
import type { MigrationHandlerContext } from '../../ledger';

let tmpDataDir: string;
let appConfig: AppConfigService;
let ctx: MigrationHandlerContext;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'session-derivation-migration-test-'));
  // session schema 落盘 {root}/session/<id>.json（非分片）；预建目录
  mkdirSync(join(tmpDataDir, 'session'), { recursive: true });
  appConfig = new AppConfigService({ root: tmpDataDir });
  ctx = { dataDir: tmpDataDir, appConfig };
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

/**
 * 造存量 session record 文件（绕过 schema 校验，模拟老版本写入的 legacy 数据）。
 * 关键：'main' 不能经 crud.put 写（schema 拒绝），必须直接 fs 落盘。
 */
function seedSessionFile(opts: {
  id: string;
  derivation: string; // 接受 'main' / 'parent' / 'subagent'（main 是关键 legacy 值）
  role?: string;
  biz?: string;
  title?: string;
  state?: string;
  parentSessionId?: string;
  usage?: unknown;
}): void {
  const rec: Record<string, unknown> = {
    id: opts.id,
    title: opts.title ?? 'test-session',
    status: 'active',
    biz: opts.biz ?? 'playground',
    role: opts.role ?? 'rocky',
    derivation: opts.derivation,
    unread: false,
    titled: false,
    ...(opts.state !== undefined ? { state: opts.state } : {}),
    ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    // 信封字段（模拟 FsCrudStore 落盘格式）
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
  writeFileSync(join(tmpDataDir, 'session', `${opts.id}.json`), JSON.stringify(rec, null, 2));
}

/** 直读 session record 文件（验证落盘结果，简单 raw 断言） */
function readSessionFile(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpDataDir, 'session', `${id}.json`), 'utf8'));
}

/** 经 store 读 record（验证迁移后 record 经 store.get 正常读 + schema 投影，不再越界） */
function readViaStore(id: string): SessionRecord | undefined {
  const crud = new CompositeStore().mount('session', new FsCrudStore({ root: tmpDataDir }));
  return crud.get(SessionSchema, id) as SessionRecord | undefined;
}

describe('sessionDerivationMainToParentMigration — case 1: main → parent', () => {
  it('derivation="main" → 迁移后变 "parent"，其他字段保留（非破坏）', async () => {
    const id = ulid();
    seedSessionFile({
      id,
      derivation: 'main',
      title: 'main-session',
      state: 'idle',
      usage: { current: { inputTokens: 100 } },
    });

    await sessionDerivationMainToParentMigration(ctx);

    const rec = readSessionFile(id);
    expect(rec.derivation).toBe('parent');
    // 非破坏断言：其他字段原样保留
    expect(rec.id).toBe(id);
    expect(rec.title).toBe('main-session');
    expect(rec.status).toBe('active');
    expect(rec.biz).toBe('playground');
    expect(rec.role).toBe('rocky');
    expect(rec.state).toBe('idle');
    expect(rec.usage).toEqual({ current: { inputTokens: 100 } });
    // 信封字段：createdAt 保留 / updatedAt=now（fresh） / version=2（+1）
    expect(rec.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(typeof rec.updatedAt).toBe('string');
    expect(rec.version).toBe(2);
  });

  it('迁移后 record 经 store.get 正常读（schema 合法，不再越界）', async () => {
    const id = ulid();
    seedSessionFile({ id, derivation: 'main' });

    await sessionDerivationMainToParentMigration(ctx);

    const rec = readViaStore(id);
    expect(rec).toBeDefined();
    expect(rec?.derivation).toBe('parent');
  });
});

describe('sessionDerivationMainToParentMigration — case 2: 已合法值不动（幂等 no-op）', () => {
  it('derivation="parent" → 完全不动（数据不变 + version 不自增）', async () => {
    const id = ulid();
    seedSessionFile({ id, derivation: 'parent', title: 'already-parent' });
    const before = readSessionFile(id);

    await sessionDerivationMainToParentMigration(ctx);

    const after = readSessionFile(id);
    expect(after.derivation).toBe('parent');
    expect(after).toEqual(before); // 完全不变（含 version / updatedAt）
  });

  it('derivation="subagent" → 不动（subagent record 不被误改）', async () => {
    const id = ulid();
    seedSessionFile({
      id,
      derivation: 'subagent',
      role: 'mate',
      biz: 'studio',
      parentSessionId: ulid(),
      title: 'studio-sub',
    });
    const before = readSessionFile(id);

    await sessionDerivationMainToParentMigration(ctx);

    const after = readSessionFile(id);
    expect(after.derivation).toBe('subagent');
    expect(after.role).toBe('mate');
    expect(after).toEqual(before); // 完全不变
  });
});

describe('sessionDerivationMainToParentMigration — case 3: 混合（只改 main 的）', () => {
  it('混合 main / parent / subagent → 只改 main 的，非 main record 不动', async () => {
    const mainId1 = ulid();
    const mainId2 = ulid();
    const parentId = ulid();
    const subagentId = ulid();
    seedSessionFile({ id: mainId1, derivation: 'main', title: 'm1' });
    seedSessionFile({ id: mainId2, derivation: 'main', title: 'm2' });
    seedSessionFile({ id: parentId, derivation: 'parent', title: 'p' });
    seedSessionFile({
      id: subagentId,
      derivation: 'subagent',
      role: 'squad',
      biz: 'studio',
      title: 's',
    });

    await sessionDerivationMainToParentMigration(ctx);

    // main → parent（被改）
    expect(readSessionFile(mainId1).derivation).toBe('parent');
    expect(readSessionFile(mainId2).derivation).toBe('parent');
    expect(readSessionFile(mainId1).title).toBe('m1'); // 非破坏
    expect(readSessionFile(mainId2).title).toBe('m2');
    // 非 main → 不动（version 不自增）
    expect(readSessionFile(parentId).derivation).toBe('parent');
    expect(readSessionFile(parentId).version).toBe(1);
    expect(readSessionFile(subagentId).derivation).toBe('subagent');
    expect(readSessionFile(subagentId).version).toBe(1);
  });
});

describe('sessionDerivationMainToParentMigration — case 4: 二次运行（幂等）', () => {
  it('二次运行（首次已改）→ 第二次 no-op（version/updatedAt 不再变）', async () => {
    const id = ulid();
    seedSessionFile({ id, derivation: 'main' });

    // 首次 run：清 main、改 parent
    await sessionDerivationMainToParentMigration(ctx);
    const afterFirst = readSessionFile(id);
    expect(afterFirst.derivation).toBe('parent');
    expect(afterFirst.version).toBe(2);

    // 二次 run：应 no-op（filter 得空集 → early return）
    await sessionDerivationMainToParentMigration(ctx);
    const afterSecond = readSessionFile(id);
    expect(afterSecond.derivation).toBe('parent');
    // 信封字段不应再次变化（未触发 putAsync）
    expect(afterSecond.version).toBe(afterFirst.version);
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
  });

  it('混合数据二次运行 → 全 no-op（main 已清空）', async () => {
    const mainId = ulid();
    const parentId = ulid();
    seedSessionFile({ id: mainId, derivation: 'main' });
    seedSessionFile({ id: parentId, derivation: 'parent' });

    await sessionDerivationMainToParentMigration(ctx);
    const mainAfterFirst = readSessionFile(mainId);
    const parentAfterFirst = readSessionFile(parentId);

    // 二次 run：全 no-op
    await sessionDerivationMainToParentMigration(ctx);
    expect(readSessionFile(mainId)).toEqual(mainAfterFirst);
    expect(readSessionFile(parentId)).toEqual(parentAfterFirst);
  });
});

describe('sessionDerivationMainToParentMigration — 边界（空数据）', () => {
  it('空 session 目录 → no-op 不抛错', async () => {
    await expect(sessionDerivationMainToParentMigration(ctx)).resolves.toBeUndefined();
    // 无文件生成
    const files = readdirSync(join(tmpDataDir, 'session'));
    expect(files).toHaveLength(0);
  });
});
