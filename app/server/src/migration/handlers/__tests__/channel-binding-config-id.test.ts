/**
 * channel-binding-config-id handler 单测 — channel_bindings 记录 instanceId → configId 改名
 * 参考: specs/tech/version_logs/v0.0.206/change_plan.md 模块九
 *       specs/tech/migration/[P0]migration_manager.md（handler 契约：幂等 MUST / 非破坏 MUST）
 *
 * 覆盖：
 *   - case 1: 旧形状记录（含 instanceId）→ 迁后 configId 承接原值 + instanceId 删除 + 信封字段不动
 *             （断 full-record 形状非只断字段存在）+ 备份目录生成
 *   - case 2: 已迁记录（仅 configId）→ no-op（内容不变，幂等）
 *   - case 3: 重跑二次 → 仍 no-op（幂等防重跑；备份不覆盖既有）
 *   - case 4: 备份目录不覆盖既有备份（预置备份 → 原备份内容保留）
 *   - case 5: 空目录 / 目录不存在 → 正常 no-op 不 throw
 *
 * 关键测试设计：旧形状记录在当前 ChannelBindingSchema 下字段已非法（instanceId 不在 schema），
 *   不能经 crud.put 写入（schema 校验拒绝）；本 UT 用 fs.writeFileSync 直接落盘 legacy 记录
 *   模拟老版本写入的数据（session-derivation-main-to-parent.test.ts 同款手法）。
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync；真实 handler 执行（不 mock）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config-service';
import { channelBindingConfigIdMigration } from '../channel-binding-config-id';
import type { MigrationHandlerContext } from '../../ledger';

let tmpDataDir: string;
let ctx: MigrationHandlerContext;

const BINDINGS_DIR = 'channel_bindings';
const BACKUP_DIR = 'channel_bindings.pre-configid.bak';

/** fs-store 扁平信封信封字段（模拟 FsCrudStore 落盘格式） */
const ENVELOPE = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  version: 3,
};

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'channel-binding-configid-test-'));
  ctx = { dataDir: tmpDataDir, appConfig: new AppConfigService({ root: tmpDataDir }) };
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

/** 直接落盘一条 binding 记录（绕过 schema 校验，模拟老版本写入） */
function seedBindingFile(id: string, record: Record<string, unknown>): void {
  mkdirSync(join(tmpDataDir, BINDINGS_DIR), { recursive: true });
  writeFileSync(join(tmpDataDir, BINDINGS_DIR, `${id}.json`), JSON.stringify(record, null, 2));
}

/** 读回落盘记录 */
function readBinding(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpDataDir, BINDINGS_DIR, `${id}.json`), 'utf8')) as Record<string, unknown>;
}

/** 造一条旧形状 binding（含 instanceId + 信封） */
function legacyRecord(instanceId: string): Record<string, unknown> {
  return {
    id: `${instanceId}__oc_chat1`,
    instanceId,
    conversationId: 'oc_chat1',
    sessionId: 'sess_1',
    boundBy: 'slash',
    boundAt: 1750000000000,
    ...ENVELOPE,
  };
}

describe('channel-binding-config-id migration', () => {
  it('case 1: 旧形状记录 → configId 承接原值 + instanceId 删除 + 信封不动 + 备份生成', async () => {
    seedBindingFile('inst_1__oc_chat1', legacyRecord('inst_1'));
    await channelBindingConfigIdMigration(ctx);

    // full-record 形状断言（非只断字段存在）
    expect(readBinding('inst_1__oc_chat1')).toEqual({
      id: 'inst_1__oc_chat1',
      configId: 'inst_1', // 承接 instanceId 原值
      conversationId: 'oc_chat1',
      sessionId: 'sess_1',
      boundBy: 'slash',
      boundAt: 1750000000000,
      ...ENVELOPE, // 信封字段原样不动
    });
    // 备份目录生成且内容为迁移前旧形状
    const backupFile = join(tmpDataDir, BACKUP_DIR, 'inst_1__oc_chat1.json');
    expect(existsSync(backupFile)).toBe(true);
    expect(JSON.parse(readFileSync(backupFile, 'utf8'))).toEqual(legacyRecord('inst_1'));
  });

  it('case 2: 已迁记录（仅 configId）→ no-op（内容不变，不生成备份）', async () => {
    const migrated = {
      id: 'cfg_1__oc_chat1',
      configId: 'cfg_1',
      conversationId: 'oc_chat1',
      sessionId: 'sess_1',
      boundBy: 'manual',
      boundAt: 1750000000001,
      ...ENVELOPE,
    };
    seedBindingFile('cfg_1__oc_chat1', migrated);
    await channelBindingConfigIdMigration(ctx);
    expect(readBinding('cfg_1__oc_chat1')).toEqual(migrated);
    // 无需迁移 → 不生成备份目录
    expect(existsSync(join(tmpDataDir, BACKUP_DIR))).toBe(false);
  });

  it('case 3: 重跑二次 → 仍 no-op（幂等防重跑）', async () => {
    seedBindingFile('inst_1__oc_chat1', legacyRecord('inst_1'));
    await channelBindingConfigIdMigration(ctx);
    const afterFirst = readBinding('inst_1__oc_chat1');
    const backupAfterFirst = readFileSync(join(tmpDataDir, BACKUP_DIR, 'inst_1__oc_chat1.json'), 'utf8');
    // 二次运行：内容不变 + 备份不变
    await channelBindingConfigIdMigration(ctx);
    expect(readBinding('inst_1__oc_chat1')).toEqual(afterFirst);
    expect(readFileSync(join(tmpDataDir, BACKUP_DIR, 'inst_1__oc_chat1.json'), 'utf8')).toBe(backupAfterFirst);
  });

  it('case 4: 备份目录已存在 → 不覆盖既有备份', async () => {
    seedBindingFile('inst_1__oc_chat1', legacyRecord('inst_1'));
    // 预置既有备份（内容为标记值，验证不被覆盖）
    mkdirSync(join(tmpDataDir, BACKUP_DIR), { recursive: true });
    writeFileSync(join(tmpDataDir, BACKUP_DIR, 'sentinel.txt'), 'pre-existing-backup');
    await channelBindingConfigIdMigration(ctx);
    // 迁移照常发生
    expect(readBinding('inst_1__oc_chat1').configId).toBe('inst_1');
    // 既有备份目录未被覆盖：标记文件仍在，且未灌入新备份
    expect(readFileSync(join(tmpDataDir, BACKUP_DIR, 'sentinel.txt'), 'utf8')).toBe('pre-existing-backup');
    expect(readdirSync(join(tmpDataDir, BACKUP_DIR))).toEqual(['sentinel.txt']);
  });

  it('case 5: 空目录 / 目录不存在 → 正常 no-op 不 throw', async () => {
    // 目录不存在
    await expect(channelBindingConfigIdMigration(ctx)).resolves.toBeUndefined();
    // 空目录
    mkdirSync(join(tmpDataDir, BINDINGS_DIR), { recursive: true });
    await expect(channelBindingConfigIdMigration(ctx)).resolves.toBeUndefined();
    expect(existsSync(join(tmpDataDir, BACKUP_DIR))).toBe(false);
  });
});
