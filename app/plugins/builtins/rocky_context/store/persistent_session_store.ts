/**
 * builtin rocky_context plugin — session_store: persistent_session_store（v0.0.66 新增）
 * 参考: reqs/[working] v0.0.66/design.md §1.1/§2.1
 *       specs/tech/agent/session/[P0]session_store.md §4
 *
 * 职责（default scope 选中）：包装现有持久 SessionStore 为 session_store EP impl。
 *   - delegate 持 bootstrap 创建的真实 SessionStore 实例（全方法）
 *   - 本类只暴露 SessionStoreContract 子集（assemble/ingest 路径所需 6 方法），
 *     其余 SessionStore 方法（createSession/listChildren/...）不经此 EP，仍由原实例直供
 *
 * 注入机制：plugin_manager 经 `new ImplClass(implId, cfg)` 实例化（仅 (implId, cfg) 签名），
 *   无法经构造器注入 SessionStore 实例。故用 server 侧的 session-store-ep-delegate holder
 *   （plugin → server 是允许的依赖方向；server → plugin 会违反 rootDir）：
 *     - bootstrap 创建 SessionStore 后调 setSessionStoreEpDelegate(store)（server 侧 holder）
 *     - 本 impl 经 getSessionStoreEpDelegate() 读 delegate（plugin → server import，方向正确）
 *   与 ContextEngine.setSideRunner 同模式：打破初始化顺序依赖。
 *
 * EP: session_store（exclusive）。default scope P0 默认选中本 impl（forked-scope-bootstrap 在
 *   forked scope setExclusive 选中 in_memory_session_store，default 不动 → 本 impl 默认 active）。
 */
import type {
  MessageInput,
} from '../../../../server/src/message/types';
import type {
  SummaryInfo,
  MessageRange,
  MessagePage,
  StoreCallOpts,
  UpdateUsageOpts,
} from '../../../../server/src/agent/session-store-types';
import type { SessionStore } from '../../../../server/src/agent/session-store';
import { ContextImplBase } from '../types';
import type { SessionStoreContract } from './types';
// [v0.0.66 §2.3] server 侧 delegate holder（plugin → server import 方向正确）
// 注：4 级 up（store/ → rocky_context/ → builtins/ → plugins/ → app/），再进 server/src/...
//   同目录其他文件的 `import type` 用 3 级（../../../server/...）是 TS bundler resolution 的历史
//   宽松路径（type-only 被 erase，Vite 不解析）；本 runtime import 必须用正确 4 级路径让 Vite 解析。
import { getSessionStoreEpDelegate } from '../../../../server/src/agent/session-store-ep-delegate';

/**
 * persistent_session_store：default scope 选中，委托 server 侧 holder 的 delegate（真实 SessionStore）。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class PersistentSessionStore
  extends ContextImplBase
  implements SessionStoreContract
{
  /** 取 delegate；未注入抛错（bootstrap 应先调 setSessionStoreEpDelegate） */
  private get store(): SessionStore {
    const d = getSessionStoreEpDelegate();
    if (!d) {
      throw new Error(
        'persistent_session_store: delegate not set — bootstrap should call setSessionStoreEpDelegate() '
        + 'before ContextEngine uses session_store EP',
      );
    }
    return d;
  }

  async appendMessages(sessionId: string, messages: MessageInput[], _opts?: StoreCallOpts): Promise<void> {
    return this.store.appendMessages(sessionId, messages);
  }

  async getMessages(sessionId: string, range?: MessageRange, _opts?: StoreCallOpts): Promise<MessagePage> {
    return this.store.getMessages(sessionId, range);
  }

  async getSummary(sessionId: string): Promise<SummaryInfo | null> {
    return this.store.getSummary(sessionId);
  }

  async getRatio(sessionId: string): Promise<number> {
    return this.store.getRatio(sessionId);
  }

  /** 统一更新 usage 并推送（写 + 推一体），委托真实 SessionStore.updateUsage */
  async updateUsage(sessionId: string, opts: UpdateUsageOpts): Promise<void> {
    return this.store.updateUsage(sessionId, opts);
  }

  /**
   * [v0.0.66 §2.6] no-op——default scope 不经此 EP 清理 session（持久 transcript 由
   * session lifecycle 管；本 EP 仅 assemble/ingest 路径消费 6 方法子集）。
   * 仅 forked run 结束时 caller 调（RunLoopHandle.start() finally 经 ContextEngine.clearScopeSession），
   * 但 forked scope 选中的是 in_memory_session_store（非本 impl），故本方法 default 路径永不被调。
   */
  async releaseSlot(_sessionId: string, _opts?: StoreCallOpts): Promise<void> {
    // 故意 no-op（持久 session 不经此 EP 删；default scope 永不调本方法）
  }
}

