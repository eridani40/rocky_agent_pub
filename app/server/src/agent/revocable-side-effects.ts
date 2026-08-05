/**
 * revocable-side-effects — loop 对外副作用权威转移（authority transfer）
 * 参考: specs/tech/version_logs/v0.0.207/change_plan.md §T2
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md §3.1
 *
 * 设计原则：abort api step1 `controller.aborted=true` 那一刻，loop 持有的所有对外副作用
 * 句柄被吊销（revoke），loop 调这些句柄 = no-op；loop 唯一职责 = 感知 aborted → break。
 *
 * 机制：JS Proxy 包装。吊销仅置内部 `revoked` 标志，不改原对象引用——abort api 直发
 * bus / store.appendMessages 不受影响（豁免），只有 loop 经 wireEmitCtx / wireContextEngine
 * 的调用被拦截。
 */
import type { EmitContext } from './agent-loop-emitters';
import type { ContextEngine } from './context-engine';

/** 吊销句柄契约（单一操作接口） */
export interface RevocableHandle {
  revoke(): void;
}

/** noop 函数（emit / clearReplay 吊销后返 undefined） */
function noopFn(): undefined {
  return undefined;
}

/** async noop 函数（ingest 吊销后返 () => Promise.resolve()） */
function asyncNoopFn(): Promise<void> {
  return Promise.resolve();
}

/**
 * 包 EmitContext：返回新 ctx + revoke 句柄。
 *
 * ctx.bus 是原 bus 的 Proxy：
 *   - revoke 前：所有属性透传（emit/subscribe/clearReplay/isReplayable/...）
 *   - revoke 后：`emit` + `clearReplay` 命中返 noop；其他属性透传
 *
 * 关键约束（change_plan §T2 row2）：
 *   - MUST 用 Proxy 包 bus（不改原 bus 引用——abort api 直发 bus 不受影响）
 *   - MUST 拦截 emit+clearReplay 两个写方法
 *   - MUST NOT 拦截 read 方法（subscribe/isReplayable/now）
 */
export function wrapRevocableEmitCtx(realCtx: EmitContext): { ctx: EmitContext; revoke: RevocableHandle } {
  let revoked = false;
  const realBus = realCtx.bus;
  const proxiedBus = new Proxy(realBus, {
    get(target, prop, receiver) {
      // 吊销后：emit/clearReplay 返 noop；其他属性透传
      if (revoked && (prop === 'emit' || prop === 'clearReplay')) {
        return (..._args: unknown[]) => { console.log(`[ABORT-DEBUG] REVOKED emit/clearReplay prop=${String(prop)}`); }; // DEBUG v0.0.207
      }
      // 其他属性（含方法）原样返回，保 this 绑定（Reflect.get 配 receiver）
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    ctx: { ...realCtx, bus: proxiedBus },
    revoke: { revoke: () => { revoked = true; } },
  };
}

/**
 * 包 ContextEngine：返回 ce proxy + revoke 句柄。
 *
 * ce 是原 ContextEngine 的 Proxy：
 *   - revoke 前：所有方法透传（ingest/assemble/getCleanSnapshot/getSideRunner/compact/...）
 *   - revoke 后：`ingest` 命中返 async noop（保 await 安全）；其他方法透传
 *
 * 关键约束（change_plan §T2 row3）：
 *   - MUST 仅拦截 ingest（写咽喉）
 *   - MUST NOT 拦截 assemble/getCleanSnapshot（read-only）/compact（独立 sideRun 路径，自带 controller）
 *   - MUST 返 Promise.resolve() 保 await 安全
 */
export function wrapRevocableContextEngine(realCe: ContextEngine): { ce: ContextEngine; revoke: RevocableHandle } {
  let revoked = false;
  const proxiedCe = new Proxy(realCe, {
    get(target, prop, receiver) {
      // 吊销后：ingest 返 async noop；其他方法透传
      if (revoked && prop === 'ingest') {
        return (..._args: unknown[]) => { console.log(`[ABORT-DEBUG] REVOKED ingest`); return Promise.resolve(); }; // DEBUG v0.0.207
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    ce: proxiedCe,
    revoke: { revoke: () => { revoked = true; } },
  };
}
