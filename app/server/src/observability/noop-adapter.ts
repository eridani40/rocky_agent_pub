/**
 * NoopAdapter — ObservabilityAdapter 默认实现（空操作，零成本）。
 * 参考: specs/tech/agent/observability/[P0]overall.md §7（持有与注入）+ §8（实现表）
 *
 * 设计：
 *   - 未配置 observability 时注入此实例（SessionConfig.observability 缺省值）
 *   - loop 无条件调 adapter，无 if 分支；Noop 时所有方法 noop，无任何副作用
 *   - startTrace 返回固定 dummy handle（保持 handle 链结构合法，供 endXxx 入参）
 *   - 天然零异常（无外部 I/O）—— 满足「不影响主流程」核心红线
 *
 * dummy handle 用固定 id（"noop"），多 run 共享同一 handle，因 Noop 下不入树、不冲突。
 */
import type { ObservabilityAdapter } from './adapter';
import type {
  GenEnd,
  GenHandle,
  GenStart,
  SpanEnd,
  SpanHandle,
  SpanStart,
  TraceEnd,
  TraceHandle,
  TraceStart,
} from './types';

/** 固定 dummy TraceHandle（Noop 下所有 run 共享，不入树） */
const NOOP_TRACE: TraceHandle = { kind: 'trace', id: 'noop-trace' };
/** 固定 dummy SpanHandle（parent 指向 trace） */
const NOOP_SPAN: SpanHandle = { kind: 'span', id: 'noop-span', parent: NOOP_TRACE };
/** 固定 dummy GenHandle（parent 指向 span） */
const NOOP_GEN: GenHandle = { kind: 'gen', id: 'noop-gen', parent: NOOP_SPAN };

/**
 * NoopAdapter — loop 默认注入，所有方法空实现。
 * startTrace/startGeneration/startSpan 返固定 dummy handle；
 * endTrace/endGeneration/endSpan 丢弃入参；shutdown 立即 resolve。
 */
export class NoopAdapter implements ObservabilityAdapter {
  startTrace(_p: TraceStart): TraceHandle {
    return NOOP_TRACE;
  }
  endTrace(_h: TraceHandle, _p?: TraceEnd): void {
    /* noop */
  }
  startGeneration(_p: GenStart): GenHandle {
    return NOOP_GEN;
  }
  endGeneration(_p: GenEnd): void {
    /* noop */
  }
  startSpan(_p: SpanStart): SpanHandle {
    return NOOP_SPAN;
  }
  endSpan(_h: SpanHandle, _p?: SpanEnd): void {
    /* noop */
  }
  async shutdown(): Promise<void> {
    /* noop —— 无 SDK 资源需释放 */
  }
}

/** 全局共享 NoopAdapter 实例（无状态，跨 session 复用） */
export const noopAdapter: ObservabilityAdapter = new NoopAdapter();
