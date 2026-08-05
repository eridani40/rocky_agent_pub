/**
 * 计数器 Zustand store — 管理渲染层本地计数状态
 * 参考: specs/ui/overall/01-counter.md §2.3（交互契约）/ specs/tech/app/frontend/[P0]tech_stack.md §3.3
 *
 * 职责：
 *   - value/loading/error 三态
 *   - fetchCounter(): GET /counter（相对路径，经 vite proxy 到 API_PORT）
 *   - incrementCounter(): POST /counter/inc
 *
 * 并发策略（ui spec §3.4 决策留实现）：inc in-flight 期间禁用按钮（loading=true）
 * 以防重复点击触发竞态；契约只锁结果（连续两次 inc 后 value+2）。
 */
import { create } from 'zustand';
import { resolveApiBase } from '../lib/api-base';

/** 计数器统一响应体（与 specs/api/overall/01-counter.md §2.3 一致） */
export interface CounterResponse {
  value: number;
  updatedAt: string;
}

/** store 状态 shape */
export interface CounterState {
  /** 当前计数值；首次加载前为 null */
  value: number | null;
  /** 请求 in-flight 标志（用于禁用按钮防竞态） */
  loading: boolean;
  /** 最近一次请求的错误信息；无错误为 null */
  error: string | null;
  /** GET /counter 拉取最新计数 */
  fetchCounter: () => Promise<void>;
  /** POST /counter/inc 自增 1；in-flight 期间直接返回（防重复点击） */
  incrementCounter: () => Promise<void>;
}

/**
 * 可注入的 fetch 实现，便于单测 mock。
 * 默认走全局 fetch（浏览器内 fetch 相对路径，vite proxy 转发到 API_PORT）。
 */
export type FetchImpl = typeof fetch;

/**
 * 创建 store。
 * @param fetchImpl 可注入 fetch（默认全局 fetch）
 * @param apiBase   API 前缀（默认从 import.meta.env.VITE_API_BASE 读取；显式传 '' = 相对路径）
 */
export function createCounterStore(fetchImpl: FetchImpl = fetch, apiBase?: string) {
  const base = resolveApiBase(apiBase);
  return create<CounterState>((set, get) => ({
    value: null,
    loading: false,
    error: null,

    async fetchCounter() {
      set({ loading: true, error: null });
      try {
        const res = await fetchImpl(`${base}/counter`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(`GET /counter failed: ${res.status}`);
        }
        const data = (await res.json()) as CounterResponse;
        set({ value: data.value, loading: false });
      } catch (e) {
        set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },

    async incrementCounter() {
      // in-flight 期间忽略并发点击，防竞态（ui spec §3.4）
      if (get().loading) return;
      set({ loading: true, error: null });
      try {
        const res = await fetchImpl(`${base}/counter/inc`, {
          method: 'POST',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(`POST /counter/inc failed: ${res.status}`);
        }
        const data = (await res.json()) as CounterResponse;
        set({ value: data.value, loading: false });
      } catch (e) {
        set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  }));
}

/** 全局单例 store（App 消费） */
export const useCounterStore = createCounterStore();
