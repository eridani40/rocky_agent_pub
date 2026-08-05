/**
 * session_store EP delegate 注入点（v0.0.66 §2.3 新建）
 * 参考: reqs/[working] v0.0.66/design.md §1.1/§2.1
 *
 * 背景：persistent_session_store（default scope 选中的 EP impl）需委托真实 SessionStore 实例。
 *   plugin_manager 经 `new ImplClass(implId, cfg)` 实例化 EP impl，构造器签名只接 (implId, cfg)，
 *   无法直接注入 SessionStore 实例。故用模块级 delegate holder + setter 后置注入（与
 *   ContextEngine.setSideRunner 同模式：打破初始化顺序依赖）。
 *
 * 为何 delegate holder 放 server 侧而非 plugin 侧：
 *   - plugin → server 是允许的依赖方向（plugin 已 import server 的 SessionStore/Message 类型）
 *   - server → plugin 会违反 rootDir（app/server/tsconfig.json rootDir=app/server/src）+
 *     语义上 plugin 是被加载的扩展，不应被 server 静态 import
 *   - 故 holder 放 server 侧（本文件），plugin 的 persistent_session_store 从此 import getDelegate；
 *     bootstrap 创建 SessionStore 后调 setSessionStoreEpDelegate(store) 完成注入（server → server）。
 */

import type { SessionStore } from './session-store';

/** 模块级 delegate：bootstrap 调 setSessionStoreEpDelegate 注入真实 SessionStore 实例 */
let delegate: SessionStore | null = null;

/**
 * bootstrap 创建 SessionStore 后调一次，注入真实实例。
 * 必须在 ContextEngine 使用 session_store EP（assemble/ingest）前调。
 */
export function setSessionStoreEpDelegate(store: SessionStore): void {
  delegate = store;
}

/** 取当前 delegate；未注入返 null（UT 探测 / persistent_session_store impl 用） */
export function getSessionStoreEpDelegate(): SessionStore | null {
  return delegate;
}
