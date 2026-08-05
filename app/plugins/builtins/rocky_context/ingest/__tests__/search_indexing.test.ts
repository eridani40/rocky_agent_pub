/**
 * search_indexing handler UT — 锁定 change_plan 模块3 的 5 个关键约束：
 *   1. role 过滤：tool/system 消息不投递
 *   2. text 提取：只 type=text part（extractPlainText 剥 image/tool_use/tool_result/reasoning）
 *   3. 投递 indexer.index 不 await（fire-and-forget：handle 返回时 index 可能未完成）
 *   4. 透传 messages（返回 === 入参引用，不 transform）
 *   5. 异常吞：indexer.index 抛错时 handle 不抛（返 messages）
 *   6. forked scope disable：forked.yaml 显式声明 search_indexing enabled:false
 *      （bootstrap 解析后 search_indexing 在 forked 不实例化 → handler.handle 不被调）
 *
 * 参考: change_plan.md §模块3 约束列
 *       specs/tech/persistence/[P1]search_engine.md §3.3（文本来源时序）+ §4（indexer 写入队列）
 *       app/plugins/scopes/forked.yaml（forked scope disable 声明）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { ScopeConfigLoader } from '../../../../../server/src/plugin/scope-config-loader';
import SearchIndexingHandler from '../search_indexing';
import type { Message, ContentBlock } from '../../../../../server/src/message/types';
import type { IngestCtx } from '../../types';
import type { HistoryIndexer, IndexPayload } from '../../../../../server/src/persistence/history-indexer';

/** 造 message（role + content blocks） */
function mkMsg(id: string, role: Message['role'], content: ContentBlock[]): Message {
  return { id, sessionId: 'test-sid', role, content };
}

/** 造 IngestCtx（只需 sessionId） */
function mkCtx(sessionId = 'test-sid'): IngestCtx {
  return { config: { sessionId } } as unknown as IngestCtx;
}

/** 造 mock HistoryIndexer：spy index() 不真落库 */
function mkMockIndexer(): {
  indexer: HistoryIndexer;
  calls: IndexPayload[][];
  throwOnce: () => void;
} {
  const calls: IndexPayload[][] = [];
  let shouldThrow = false;
  const indexer = {
    index: vi.fn((payload: IndexPayload | IndexPayload[]) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('mock indexer index error');
      }
      calls.push(Array.isArray(payload) ? payload : [payload]);
    }),
  } as unknown as HistoryIndexer;
  return {
    indexer,
    calls,
    throwOnce: () => {
      shouldThrow = true;
    },
  };
}

describe('SearchIndexingHandler', () => {
  let handler: SearchIndexingHandler;

  beforeEach(() => {
    handler = new SearchIndexingHandler('search_indexing', {});
  });

  describe('role 过滤', () => {
    it('role=user + role=assistant 投递；role=tool 跳过', () => {
      const { indexer, calls } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [
        mkMsg('01', 'user', [{ type: 'text', text: 'hello' }]),
        mkMsg('02', 'assistant', [{ type: 'text', text: 'hi' }]),
        mkMsg('03', 'tool', [{ type: 'tool_result', toolUseId: 'x', content: 'out' }]),
      ];
      handler.handle(msgs, mkCtx());
      expect(calls).toHaveLength(1);
      const payload = calls[0]!;
      expect(payload).toHaveLength(2);
      expect(payload.map((p) => p.role)).toEqual(['user', 'assistant']);
    });

    it('role=system 跳过', () => {
      const { indexer, calls } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [
        mkMsg('01', 'system', [{ type: 'text', text: 'sys prompt' }]),
        mkMsg('02', 'user', [{ type: 'text', text: 'q' }]),
      ];
      handler.handle(msgs, mkCtx());
      expect(calls[0]!).toHaveLength(1);
      expect(calls[0]![0]!.role).toBe('user');
    });
  });

  describe('text 提取（只 type=text part）', () => {
    it('剥 image / tool_use / tool_result block，只取 type=text', () => {
      const { indexer, calls } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [
        mkMsg('01', 'user', [
          { type: 'text', text: 'first' } as ContentBlock,
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } } as ContentBlock,
          { type: 'text', text: 'second' } as ContentBlock,
        ]),
      ];
      handler.handle(msgs, mkCtx());
      expect(calls[0]!).toHaveLength(1);
      // 两 text 块用 \n 拼接
      expect(calls[0]![0]!.text).toBe('first\nsecond');
    });

    it('tool_use / tool_result block 不进 text', () => {
      const { indexer, calls } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [
        mkMsg('01', 'assistant', [
          { type: 'text', text: 'calling' } as ContentBlock,
          { type: 'tool_call', id: 'tc1', name: 'bash', input: { cmd: 'echo' } } as ContentBlock,
        ]),
        mkMsg('02', 'tool', [
          { type: 'tool_result', toolUseId: 'tc1', content: 'output' } as ContentBlock,
        ]),
      ];
      handler.handle(msgs, mkCtx());
      // 只有 01 assistant 进索引（02 tool 被跳过）
      expect(calls[0]!).toHaveLength(1);
      expect(calls[0]![0]!.text).toBe('calling');
    });

    it('空 text 消息不投递（无搜索价值）', () => {
      const { indexer, calls } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [
        mkMsg('01', 'assistant', [{ type: 'tool_call', id: 'tc1', name: 'bash', input: {} } as ContentBlock]),
      ];
      handler.handle(msgs, mkCtx());
      // 无 text block → extractPlainText 返空 → 不投
      expect(calls).toHaveLength(0);
    });
  });

  describe('ts = messageId（ULID 字典序 = 时间序）', () => {
    it('payload.ts === payload.messageId', () => {
      const { indexer, calls } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [mkMsg('01HZULIDXXX', 'user', [{ type: 'text', text: 'q' }])];
      handler.handle(msgs, mkCtx());
      expect(calls[0]![0]!.ts).toBe('01HZULIDXXX');
      expect(calls[0]![0]!.messageId).toBe('01HZULIDXXX');
    });

    it('payload.sessionId === ctx.config.sessionId', () => {
      const { indexer, calls } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [mkMsg('01', 'user', [{ type: 'text', text: 'q' }])];
      handler.handle(msgs, mkCtx('my-session'));
      expect(calls[0]![0]!.sessionId).toBe('my-session');
    });
  });

  describe('投递 indexer.index 不 await（fire-and-forget）', () => {
    it('handle 同步返回（不 await indexer）— handle 签名是 sync', () => {
      // handle 是 sync 方法（return Message[] 非 Promise）—— 若 await indexer 会变 async
      // 此测锁定：handle 不 await
      const { indexer } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [mkMsg('01', 'user', [{ type: 'text', text: 'q' }])];
      const ret = handler.handle(msgs, mkCtx());
      // sync 返回 Message[]（非 Promise）
      expect(Array.isArray(ret)).toBe(true);
    });
  });

  describe('透传 messages（返回 === 入参引用，不 transform）', () => {
    it('返回值是入参数组同一引用', () => {
      const { indexer } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [mkMsg('01', 'user', [{ type: 'text', text: 'q' }])];
      const ret = handler.handle(msgs, mkCtx());
      expect(ret).toBe(msgs); // 引用相等
    });

    it('不修改 messages 内容（深相等）', () => {
      const { indexer } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [mkMsg('01', 'user', [{ type: 'text', text: 'q' }])];
      const before = JSON.parse(JSON.stringify(msgs));
      handler.handle(msgs, mkCtx());
      expect(JSON.parse(JSON.stringify(msgs))).toEqual(before);
    });
  });

  describe('异常吞（indexer.index 抛错时 handle 不抛）', () => {
    it('indexer.index 抛错 → handle 返 messages 不传播', () => {
      const { indexer, throwOnce } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [mkMsg('01', 'user', [{ type: 'text', text: 'q' }])];
      throwOnce();
      expect(() => handler.handle(msgs, mkCtx())).not.toThrow();
      const ret = handler.handle(msgs, mkCtx());
      expect(ret).toBe(msgs);
    });
  });

  describe('indexer 未注入 → no-op', () => {
    it('未调 setIndexer → handle 返 messages 不投递', () => {
      const msgs = [mkMsg('01', 'user', [{ type: 'text', text: 'q' }])];
      const ret = handler.handle(msgs, mkCtx());
      expect(ret).toBe(msgs);
      expect(handler.getIndexer()).toBeNull();
    });

    it('sessionId 缺失 → no-op（不动 messages）', () => {
      const { indexer, calls } = mkMockIndexer();
      handler.setIndexer(indexer);
      const msgs = [mkMsg('01', 'user', [{ type: 'text', text: 'q' }])];
      // 空 sessionId
      const ctx = { config: {} } as unknown as IngestCtx;
      const ret = handler.handle(msgs, ctx);
      expect(ret).toBe(msgs);
      expect(calls).toHaveLength(0);
    });
  });
});

describe('SearchIndexingHandler — summary scope 不激活 search_indexing（声明层 v0.0.179）', () => {
  /**
   * v0.0.179 模型简化（membership）：summary.yaml 的 context_ingest_handler 不列 search_indexing
   * → search_indexing 在 summary scope inactive → ContextEngine 在 summary 不实例化 → handle 永不被调。
   *
   * 此测验证声明文件正确（summary.impls 不含 search_indexing），是「summary 不调」的根因。
   * 运行时行为（handle 不被调）由 PluginManager 装配链保证，不在 handler UT 范围。
   *
   * v0.0.204：forked.yaml 已删（拆为 summary + consolidate 基座），原 forked 用例改为 summary。
   */
  it('summary.yaml 不列 search_indexing（v0.0.179 membership 模型：不列 = inactive）', () => {
    const scopesDir = join(process.cwd(), 'app/plugins/scopes');
    const configs = new ScopeConfigLoader(scopesDir).loadAll();
    const summary = configs.find((c) => c.scopeId === 'summary');
    expect(summary, 'summary.yaml 必须存在').toBeDefined();
    // v0.0.179：不列 = inactive（membership 模型，废 enabled:false 写法）
    expect(summary!.impls['search_indexing'], 'summary.impls.search_indexing 必须不在（inactive）').toBeUndefined();
  });

  it('default.yaml 列 search_indexing（v0.0.179 membership 模型：列 = active）', () => {
    const scopesDir = join(process.cwd(), 'app/plugins/scopes');
    const configs = new ScopeConfigLoader(scopesDir).loadAll();
    const def = configs.find((c) => c.scopeId === 'default');
    expect(def).toBeDefined();
    // v0.0.179：default 显式列 search_indexing（active；search.sqlite 唯一 ingest 写入路径）
    const entry = def!.impls['search_indexing'];
    expect(entry, 'default.impls.search_indexing 必须显式声明（active）').toBeDefined();
  });
});
