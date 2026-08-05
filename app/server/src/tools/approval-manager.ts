/**
 * 审批层记忆模块（per-session 持久化 + cache-through）
 * 参考: specs/tech/agent/tools/[P0]tool_permission.md §5
 *       specs/tech/version_logs/v0.0.148/change_plan.md 链路 C（纠正 v0.0.122 D2）
 *
 * v0.0.148 纠正 D2：从纯内存改为 cache-through + ApprovalStorePort。
 *   - cache（Map<sessionId, Set<approvalKey>>）随进程生命周期，热路径不每次读盘
 *   - store（ApprovalStorePort）跨重启持久化，post-bootstrap 注入（对齐 contextEngine.setSessionStore）
 * 会话隔离：会话 A 的 recordAlways 不影响会话 B（按 sessionId 独立 Set）。
 */

/**
 * 审批持久化端口（薄 2 方法，依赖倒置）。
 * SessionStore 实现此 port（bootstrap 注入）；ApprovalManager 不耦合 SessionStore 具体类。
 */
export interface ApprovalStorePort {
  /** 读 sid 的全部 always-approved keys（兼容缺省返 []） */
  getAlwaysApprovedKeys(sid: string): Promise<string[]>;
  /** 追加一个 key（read-modify-write 去重；复用 SessionStore.updateSession patch） */
  addAlwaysApprovedKey(sid: string, key: string): Promise<void>;
}

/**
 * 审批记忆管理器（cache-through + 可选 store 持久化）。
 *
 * cache-through 语义：
 *   - isApproved: cache hit → 直接判定；cache miss + store wired → 读 store 填 cache 后判定；
 *     cache miss + 无 store → false（向后兼容 UT 隔离）
 *   - recordAlways: 先更新 cache（同步，同 run 内立即可见）→ store wired 则 write-through
 *
 * 方法（均 async）：
 *   - isApproved(sessionId, approvalKey): Promise<boolean>
 *   - recordAlways(sessionId, approvalKey): Promise<void>
 *   - setStore(port): void（post-bootstrap 注入）
 */
export class ApprovalManager {
  /** sessionId → 已「永远同意」的 approvalKey 集合（cache） */
  private map = new Map<string, Set<string>>();
  /**
   * 持久化端口（post-bootstrap 注入；缺省 undefined = UT 隔离 / 无持久化）。
   * cache miss 且 wired 时读 store 填 cache；recordAlways write-through 到 store。
   */
  private store?: ApprovalStorePort;

  /**
   * 注入持久化端口（post-bootstrap 调，对齐 contextEngine.setSessionStore 模式）。
   * 非构造函数注入：bootstrap 顺序中 ApprovalManager 单例先于 SessionStore 就绪。
   */
  setStore(port: ApprovalStorePort): void {
    this.store = port;
  }

  /**
   * 查询 (sessionId, approvalKey) 是否已被用户「永远同意」过（cache-through）。
   *
   * @param sessionId 所属会话 id
   * @param approvalKey 拦截原因的稳定标识（如 `bash:rm-wildcard`）
   * @returns true 表示本会话已记忆，引擎跳过审批卡直接 fall through
   */
  async isApproved(sessionId: string, approvalKey: string): Promise<boolean> {
    const keys = this.map.get(sessionId);
    if (keys !== undefined) {
      // cache hit（含空 Set：sessionId 已查过/记录过，直接用 cache，不读盘）
      return keys.has(approvalKey);
    }
    // cache miss：store wired 则读 store 填 cache
    if (this.store) {
      const persisted = await this.store.getAlwaysApprovedKeys(sessionId);
      const cache = new Set(persisted);
      this.map.set(sessionId, cache);
      return cache.has(approvalKey);
    }
    // 无 store：返 false（向后兼容 UT 隔离，不填 cache 避免语义歧义）
    return false;
  }

  /**
   * 记录 (sessionId, approvalKey)「永远同意」（write-through，allow_always 回填时调用）。
   * 先更新 cache（同步，同 run 内立即可见），store wired 则 write-through 持久化。
   *
   * @param sessionId 所属会话 id
   * @param approvalKey 拦截原因的稳定标识（同 isApproved 的 key）
   */
  async recordAlways(sessionId: string, approvalKey: string): Promise<void> {
    let keys = this.map.get(sessionId);
    if (!keys) {
      keys = new Set<string>();
      this.map.set(sessionId, keys);
    }
    keys.add(approvalKey);
    if (this.store) {
      await this.store.addAlwaysApprovedKey(sessionId, approvalKey);
    }
  }
}

/**
 * 进程级单例 ApprovalManager 实例。
 *
 * engine 默认注入此单例（constructor 可通过参数覆盖，便于 UT 注入 fresh 实例）。
 * tool-reply-handler.ts 直接 import 此单例（allow_always 回填时调 recordAlways）。
 * bootstrap 在 SessionStore 就绪后调 setStore 注入持久化端口。
 */
export const approvalManager = new ApprovalManager();
