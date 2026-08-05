/**
 * SessionStore 单元测试 — schema round-trip + getMessages 分页 + deleteSession 级联
 * 参考: states/v0.0.8/task.json task-1 acceptance（vitest UT 三大维度）
 *       specs/tech/version_logs/v0.0.8/change_log.md §6（getMessages 分页 + 级联删）
 *
 * 覆盖：
 *   - schema round-trip：session/run/message/summary create→read→list→delete
 *   - getMessages 三种 range：beforeId / 末尾 limit / hasMore 切换
 *   - deleteSession 级联：session 自身 + sessions/<sid>/ 下 message/summary/runs 目录
 *
 * 真实落盘：fs engine + 临时 DATA_DIR（os.tmpdir + mkdtempSync）+ afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import {
  SessionSchema,
  MessageSchema,
  SummarySchema,
  RunSchema,
} from '../schema_defs';
import { SessionStore } from '../session-store';
import type { MessageInput } from '../../message/types';

// 公共 fixture

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-store-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  // mount 4 schema 到同一 fs engine（CompositeStore 按 entity 路由）
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造一条业务 Message（业务 put 形态） */
function newMessage(
  sessionId: string,
  text: string,
  extra: Partial<MessageInput> = {},
): MessageInput {
  return {
    id: extra.id ?? ulid(),
    sessionId,
    role: extra.role ?? 'user',
    content: extra.content ?? [{ type: 'text', text }],
    ...extra,
  };
}

// 1. schema round-trip

describe('SessionStore — schema round-trip', () => {
  it('session: create → get → list → delete', async () => {
    const sid = ulid();
    const created = await store.createSession({ id: sid, title: 't1' });
    expect(created.id).toBe(sid);
    expect(created.status).toBe('active');
    expect(created.title).toBe('t1');
    expect(created.version).toBe(1);

    const got = await store.getSession(sid);
    expect(got?.id).toBe(sid);
    expect(got?.title).toBe('t1');

    const list = await store.listSessions();
    expect(list.find((s) => s.id === sid)).toBeDefined();

    await store.deleteSession(sid);
    expect(await store.getSession(sid)).toBeNull();
  });

  it('run: create → get → update → list', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    const run = await store.createRun({ id: runId, sessionId: sid });
    expect(run.status).toBe('running');
    expect(run.startedAt).toBeDefined();

    await store.updateRun(sid, runId, {
      status: 'completed',
      stopReason: 'no_tool_call',
    });
    const got = await store.getRun(sid, runId);
    expect(got?.status).toBe('completed');
    expect(got?.stopReason).toBe('no_tool_call');
    expect(got?.version).toBe(2);

    const runs = await store.getRuns(sid);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
  });

  it('message: appendMessages → getMessages → getMessagesByRun', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    const msgs = [
      newMessage(sid, 'hello', { runId }),
      newMessage(sid, 'world', { runId, role: 'assistant' }),
    ];
    await store.appendMessages(sid, msgs);

    const page = await store.getMessages(sid);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.content[0]).toMatchObject({ type: 'text', text: 'hello' });

    const byRun = await store.getMessagesByRun(sid, runId);
    expect(byRun).toHaveLength(2);
  });

  it('summary: setSummary → getSummary → overwrite(version 自增)', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    expect(await store.getSummary(sid)).toBeNull();

    await store.setSummary(sid, { content: 'v1 summary', summaryUpTo: 'm1' });
    const s1 = await store.getSummary(sid);
    expect(s1?.content).toBe('v1 summary');
    expect(s1?.summaryUpTo).toBe('m1');
    expect(s1?.version).toBe(1);

    await store.setSummary(sid, { content: 'v2 summary', summaryUpTo: 'm2' });
    const s2 = await store.getSummary(sid);
    expect(s2?.content).toBe('v2 summary');
    expect(s2?.summaryUpTo).toBe('m2');
    expect(s2?.version).toBe(2);
  });
});

// 2. getMessages 三种 range（acceptance #2）

describe('SessionStore.getMessages — 分页三态', () => {
  // 预置 60 条消息（id 升序 = 时间序）
  let sid: string;
  let msgIds: string[];

  beforeEach(async () => {
    sid = ulid();
    await store.createSession({ id: sid });
    msgIds = [];
    // 注意：ulid() 同步内单调递增，连续调用字典序 = 时间序
    for (let i = 0; i < 60; i++) {
      const id = ulid();
      msgIds.push(id);
    }
    // 用显式有序 id 构造 messages（避免时间精度问题）
    const msgs: MessageInput[] = msgIds.map((id, i) => ({
      id,
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: `msg-${i}` }],
    }));
    await store.appendMessages(sid, msgs);
  });

  it('末尾 limit：无 beforeId → 返回末尾 N 条（升序），hasMore=true', async () => {
    const page = await store.getMessages(sid, { limit: 50 });
    expect(page.items).toHaveLength(50);
    // 末尾 50 条 = msgIds[10..59]
    expect(page.items[0]!.id).toBe(msgIds[10]!);
    expect(page.items[49]!.id).toBe(msgIds[59]!);
    expect(page.hasMore).toBe(true);
  });

  it('beforeId：取该 id 之前的 limit 条', async () => {
    // beforeId = msgIds[10]，取其之前 50 条 → 应只有 msgIds[0..9] 共 10 条
    const page = await store.getMessages(sid, {
      limit: 50,
      beforeId: msgIds[10]!,
    });
    expect(page.items).toHaveLength(10);
    expect(page.items[0]!.id).toBe(msgIds[0]!);
    expect(page.items[9]!.id).toBe(msgIds[9]!);
    // 之前不足 50 条 → hasMore=false
    expect(page.hasMore).toBe(false);
  });

  it('beforeId 中段：取该 id 之前 limit 条，hasMore=true（还有更早）', async () => {
    // beforeId = msgIds[55]，之前有 55 条（msgIds[0..54]），取末尾 50 → msgIds[5..54]
    const page = await store.getMessages(sid, {
      limit: 50,
      beforeId: msgIds[55]!,
    });
    expect(page.items).toHaveLength(50);
    expect(page.items[0]!.id).toBe(msgIds[5]!);
    expect(page.items[49]!.id).toBe(msgIds[54]!);
    expect(page.hasMore).toBe(true);
  });

  it('hasMore 切换：limit 覆盖总数时 false', async () => {
    const page = await store.getMessages(sid, { limit: 100 });
    expect(page.items).toHaveLength(60);
    expect(page.hasMore).toBe(false);
  });

  it('默认 limit=50（不传 limit）', async () => {
    const page = await store.getMessages(sid);
    expect(page.items).toHaveLength(50);
    expect(page.hasMore).toBe(true);
  });

  // [v0.0.185] takeFromStart：head 候选锚定会话真第一条（prompt 缓存前缀稳定）
  it('[v0.0.185] takeFromStart：取范围头部 N 条（锚定真第一条）', async () => {
    const page = await store.getMessages(sid, { limit: 5, takeFromStart: true });
    // 头部 5 条 = msgIds[0..4]（缺省行为是取尾部）
    expect(page.items).toHaveLength(5);
    expect(page.items[0]!.id).toBe(msgIds[0]!);
    expect(page.items[4]!.id).toBe(msgIds[4]!);
    expect(page.hasMore).toBe(true);
  });

  it('[v0.0.185] takeFromStart + upToId：头部 N 条且不越 summaryUpTo 锚点', async () => {
    const page = await store.getMessages(sid, {
      limit: 5,
      upToId: msgIds[10]!,
      takeFromStart: true,
    });
    // 范围 = msgIds[0..10]（含 upToId），取头部 5 条
    expect(page.items).toHaveLength(5);
    expect(page.items[0]!.id).toBe(msgIds[0]!);
    expect(page.items[4]!.id).toBe(msgIds[4]!);
    expect(page.hasMore).toBe(true);
  });
});

// 3. deleteSession 级联（acceptance #3）

describe('SessionStore.deleteSession — 级联删 message/summary/runs', () => {
  it('删 session 后 sessions/<sid>/ 目录清空（含 message/summary/runs）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    await store.createRun({ id: runId, sessionId: sid });
    await store.appendMessages(sid, [newMessage(sid, 'a'), newMessage(sid, 'b')]);
    await store.setSummary(sid, { content: 'sum', summaryUpTo: 'x' });

    // 落盘目录存在性预检
    const sessionDir = join(tmpRoot, 'sessions', sid);
    expect(existsSync(sessionDir)).toBe(true);
    expect(readdirSync(sessionDir).sort()).toEqual([
      'runs',
      'summary',
      'transcript',
    ]);

    await store.deleteSession(sid);

    // session 自身已删
    expect(await store.getSession(sid)).toBeNull();
    // sessions/<sid>/ 目录已被 rm -rf 清空
    expect(existsSync(sessionDir)).toBe(false);
    // transcript/summary/runs 查询都为空
    expect((await store.getMessages(sid)).items).toEqual([]);
    expect(await store.getSummary(sid)).toBeNull();
    expect(await store.getRuns(sid)).toEqual([]);
  });

  it('删除不存在的 session 幂等（不抛错）', async () => {
    const sid = ulid();
    await expect(store.deleteSession(sid)).resolves.toBeUndefined();
  });
});

// 4. 落盘路径自检（acceptance #3）

describe('SessionStore — 落盘路径 = {DATA_DIR}/sessions/{sid}/transcript/<seg>.jsonl', () => {
  it('appendMessages 后 transcript jsonl 文件落在正确路径', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.appendMessages(sid, [newMessage(sid, 'hello')]);

    const transcriptDir = join(tmpRoot, 'sessions', sid, 'transcript');
    expect(existsSync(transcriptDir)).toBe(true);
    const files = readdirSync(transcriptDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});

// 5. usage 简化方法（change_log §6）

describe('SessionStore — usage 简化口径（v0.0.8）', () => {
  it('updateContextWindowUsage 写 session.contextWindowUsage', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // [v0.0.16] 7 字段 ContextWindowUsage
    const cw = {
      systemTokens: 20,
      messageTokens: 150,
      toolTokens: 30,
      totalTokens: 200,
      maxOutputTokens: 20000,
      tokenLimit: 1000,
      remainingTokens: 1000 - 200 - 20000,
    };
    await store.updateContextWindowUsage(sid, cw);
    const got = await store.getSession(sid);
    expect(got?.contextWindowUsage).toEqual(cw);
  });

  it('persistUsage 写 run.contextWindowUsage', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const runId = ulid();
    await store.createRun({ id: runId, sessionId: sid });
    // [v0.0.16] 7 字段 ContextWindowUsage
    const cw = {
      systemTokens: 10,
      messageTokens: 80,
      toolTokens: 10,
      totalTokens: 100,
      maxOutputTokens: 20000,
      tokenLimit: 2000,
      remainingTokens: 2000 - 100 - 20000,
    };
    await store.persistUsage(sid, runId, cw);
    const run = await store.getRun(sid, runId);
    expect(run?.contextWindowUsage).toEqual(cw);
  });

  it('accumulateUsage 已激活（v0.0.14）：累加 current 分区 + llmCallCount++', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.accumulateUsage(sid, 'current', {
      total_tokens: 100, input_total_tokens: 80, output_total_tokens: 20, cost: 0.01,
    });
    await store.accumulateUsage(sid, 'current', {
      total_tokens: 50, input_total_tokens: 40, output_total_tokens: 10, cost: 0.005,
    });
    const view = await store.getUsageView(sid);
    expect(view.current.total_tokens).toBe(150);
    expect(view.current.llmCallCount).toBe(2);
    expect(view.current.cost).toBeCloseTo(0.015, 6);
    expect(view.total.total_tokens).toBe(150);
    expect(view.total.llmCallCount).toBe(2);
    expect(view.sub.total_tokens).toBeUndefined();
  });

  it('getRatio 冷启动 1.0；满 3 sample 取中位数（非 1.0）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    expect(await store.getRatio(sid)).toBe(1.0); // 冷启动
    // 喂 3 个 sample：input_total_tokens / inputCharCount = 0.5 / 1.0 / 2.0 → clamp 后中位数 1.0
    await store.accumulateUsage(sid, 'current', { input_total_tokens: 500, inputCharCount: 1000 });
    await store.accumulateUsage(sid, 'current', { input_total_tokens: 1000, inputCharCount: 1000 });
    await store.accumulateUsage(sid, 'current', { input_total_tokens: 2000, inputCharCount: 1000 });
    // 窗口满 3 → 取中位数 [0.5,1.0,2.0].sort[1] = 1.0
    expect(await store.getRatio(sid)).toBe(1.0);
    // 再喂 1 个：窗口=[1.0,2.0,3.0] → 中位数 2.0（非 1.0）
    await store.accumulateUsage(sid, 'current', { input_total_tokens: 3000, inputCharCount: 1000 });
    expect(await store.getRatio(sid)).toBe(2.0);
  });

  it('accumulateUsage 递归 sub 上报 parent', async () => {
    const parent = ulid();
    const child = ulid();
    await store.createSession({ id: parent });
    await store.createSession({ id: child, parentSessionId: parent });
    await store.accumulateUsage(child, 'current', { total_tokens: 200 });
    // parent 应有 sub 分区累计
    const parentView = await store.getUsageView(parent);
    expect(parentView.sub.total_tokens).toBe(200);
    expect(parentView.sub.llmCallCount).toBe(1);
    // parent 的 current 不受影响
    expect(parentView.current.total_tokens).toBeUndefined();
    expect(parentView.total.total_tokens).toBe(200); // total = Σ(current, sub, forked)
  });

  it('forked 分区独立累计（不学 ratio）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.accumulateUsage(sid, 'forked', { total_tokens: 300, input_total_tokens: 250, inputCharCount: 100 });
    const view = await store.getUsageView(sid);
    expect(view.forked.total_tokens).toBe(300);
    expect(view.forked.llmCallCount).toBe(1);
    // forked 不学 ratio → 窗口仍空，ratio=1.0
    expect(await store.getRatio(sid)).toBe(1.0);
  });

  it('getUsageView 派生 total = Σ 三分区', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.accumulateUsage(sid, 'current', { total_tokens: 100, cost: 0.01 });
    await store.accumulateUsage(sid, 'forked', { total_tokens: 50, cost: 0.005 });
    const view = await store.getUsageView(sid);
    expect(view.total.total_tokens).toBe(150);
    expect(view.total.cost).toBeCloseTo(0.015, 6);
    expect(view.total.llmCallCount).toBe(2);
  });
});

// 6. updateSession 部分更新

describe('SessionStore.updateSession — 部分更新', () => {
  it('只传 title，status 保留', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, title: 'old', status: 'active' });
    await store.updateSession(sid, { title: 'new' });
    const got = await store.getSession(sid);
    expect(got?.title).toBe('new');
    expect(got?.status).toBe('active');
  });

  it('更新不存在 session 抛 SessionNotFoundError', async () => {
    const sid = ulid();
    await expect(store.updateSession(sid, { title: 'x' })).rejects.toThrow();
  });
});

// 7. v0.0.9 手动选 model 持久化（session schema providerId/modelId round-trip + update）

describe('SessionStore — v0.0.9 手动选 model 持久化', () => {
  it('createSession 带 providerId/modelId → getSession 返回持久值', async () => {
    const sid = ulid();
    const created = await store.createSession({
      id: sid,
      title: 'with-model',
      providerId: 'prov-1',
      modelId: 'claude-mock-1',
    });
    expect(created.providerId).toBe('prov-1');
    expect(created.modelId).toBe('claude-mock-1');

    const got = await store.getSession(sid);
    expect(got?.providerId).toBe('prov-1');
    expect(got?.modelId).toBe('claude-mock-1');
  });

  it('createSession 不带 providerId/modelId → getSession 返回 undefined', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const got = await store.getSession(sid);
    expect(got?.providerId).toBeUndefined();
    expect(got?.modelId).toBeUndefined();
  });

  it('updateSession 改 model → 持久', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'p1', modelId: 'm1' });
    await store.updateSession(sid, { providerId: 'p2', modelId: 'm2' });
    const got = await store.getSession(sid);
    expect(got?.providerId).toBe('p2');
    expect(got?.modelId).toBe('m2');
  });

  it('updateSession 只改 modelId，providerId 保留', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'p1', modelId: 'm1' });
    await store.updateSession(sid, { modelId: 'm2' });
    const got = await store.getSession(sid);
    expect(got?.providerId).toBe('p1');
    expect(got?.modelId).toBe('m2');
  });

  it('listSessions 返回的 Session 含 providerId/modelId', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, providerId: 'p1', modelId: 'm1' });
    const list = await store.listSessions();
    const found = list.find((s) => s.id === sid);
    expect(found?.providerId).toBe('p1');
    expect(found?.modelId).toBe('m1');
  });
});
