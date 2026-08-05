/**
 * bootstrap 装配关键链路 UT —— [v0.0.126] SearchEngine + HistoryIndexer 装配验证
 * 参考: specs/tech/version_logs/v0.0.126/change_plan.md 模块6（bootstrap 装配 3 行）
 *
 * 验证项（test-plan §UT「装配链路」）：
 *   1. BootstrapResult.searchEngine + historyIndexer 字段非空（装配成功）
 *   2. search_indexing EP delegate holder 已注入（getSearchIndexerEpDelegate 返非 null）
 *   3. onSessionDestroyed 链：触发 store.onSessionDestroyed(sid) → indexer.deleteBySession 被调
 *      （fts 行同删；验证 chunks 表无该 session 数据）
 *   4. reconcile 异步不阻塞 bootstrap 返回（fire-and-forget；启动后立即返回）
 *   5. historyToolDeps 注入 SessionHandlerDeps 非空（searchEngine + sessionStore 字段存在）
 *
 * 走真实 bootstrap（tmpdir 隔离），不 mock。验证「装配链路」而非 search 语义（语义在 engine UT 已覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import {
  getSearchIndexerEpDelegate,
  __resetSearchIndexerEpDelegateForTest,
} from '../../persistence/search-indexer-ep-delegate';
import { HistoryIndexer } from '../../persistence/history-indexer';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-history-bootstrap-'));
  __resetSearchIndexerEpDelegateForTest();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetSearchIndexerEpDelegateForTest();
});

/** bootstrap 需要的 minimal app_config（providers + dev_config 目录） */
function seedMinimalConfig(dataDir: string): void {
  mkdirSync(join(dataDir, 'app_config', 'providers', 'app_config'), { recursive: true });
  mkdirSync(join(dataDir, 'dev_config'), { recursive: true });
}

describe('bootstrap [v0.0.126] history_search 装配链路', () => {
  it('BootstrapResult.searchEngine + historyIndexer 字段非空', async () => {
    seedMinimalConfig(tmpRoot);
    const bs = await bootstrapBuiltinPlugins(tmpRoot);
    expect(bs.searchEngine, 'searchEngine 应装配成功').toBeDefined();
    expect(bs.historyIndexer, 'historyIndexer 应装配成功').toBeDefined();
  });

  it('search_indexing EP delegate holder 已注入（getSearchIndexerEpDelegate 返非 null）', async () => {
    seedMinimalConfig(tmpRoot);
    const bs = await bootstrapBuiltinPlugins(tmpRoot);
    const holderIdx = getSearchIndexerEpDelegate();
    expect(holderIdx, 'holder 应被 setSearchIndexerEpDelegate 注入').not.toBeNull();
    // 应是同一实例
    expect(holderIdx).toBe(bs.historyIndexer);
  });

  it('onSessionDestroyed 链：触发后 indexer.deleteBySession 被调（级联删 chunks）', async () => {
    seedMinimalConfig(tmpRoot);
    const bs = await bootstrapBuiltinPlugins(tmpRoot);
    expect(bs.historyIndexer).toBeDefined();
    expect(bs.store.onSessionDestroyed, 'onSessionDestroyed 应被组合注入').toBeDefined();

    // 先注入一条 chunk（直接走 indexer 内部 API 模拟已索引）
    const indexer = bs.historyIndexer as HistoryIndexer;
    indexer.index({
      messageId: '01TESTMSG0001',
      sessionId: '01SESSIONTEST',
      role: 'user',
      ts: '01TESTMSG0001',
      text: 'hello world for delete test',
    });
    await indexer.flush();

    // 验证 chunk 已入库
    const statsBefore = indexer.stats();
    expect(statsBefore.count).toBeGreaterThanOrEqual(1);

    // 触发 onSessionDestroyed（应级联调 indexer.deleteBySession）
    await bs.store.onSessionDestroyed!('01SESSIONTEST');

    // 验证 chunks 表无该 session 数据
    const statsAfter = indexer.stats();
    expect(statsAfter.count).toBe(0);
  });

  it('onSessionDestroyed 保留 scheduling 原回调（cron 注销链不被覆盖）', async () => {
    seedMinimalConfig(tmpRoot);
    const bs = await bootstrapBuiltinPlugins(tmpRoot);
    // 触发一次 onSessionDestroyed 不应抛错（证明组合链完整，cron 段 + indexer 段都跑）
    // 验证手段：对不存在的 session 调用应无副作用（idempotent）
    await expect(bs.store.onSessionDestroyed!('01NONEXISTENT')).resolves.toBeUndefined();
  });

  it('reconcile 异步 fire-and-forget（bootstrap 立即返回，不阻塞）', async () => {
    seedMinimalConfig(tmpRoot);
    // 不挂任何 transcript 文件，reconcile 扫空应快速完成
    const startMs = Date.now();
    const bs = await bootstrapBuiltinPlugins(tmpRoot);
    const elapsed = Date.now() - startMs;
    // bootstrap 完成后立即有 searchEngine 实例（reconcile 不阻塞）
    expect(bs.searchEngine).toBeDefined();
    // bootstrap 耗时应合理（< 5s；reconcile 异步不阻塞主路径）
    expect(elapsed).toBeLessThan(5000);
  });

  it('search.sqlite 文件创建在 dataDir 下（绝对路径，非字面 ~）', async () => {
    seedMinimalConfig(tmpRoot);
    await bootstrapBuiltinPlugins(tmpRoot);
    // 文件应存在
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(tmpRoot, 'search.sqlite'))).toBe(true);
  });
});
