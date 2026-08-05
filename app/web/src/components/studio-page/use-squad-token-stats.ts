/**
 * use-squad-token-stats —— token 用量统计 fetch hook（详情 panel + 首页 widget 共用，一套统计）
 * 参考: specs/api/overall/11c-token-stats.md §3（fetchTokenStats 契约）
 *       specs/ui/components/studio-page/component-token-stats.md（详情口径权威）
 *
 * 职责：封装 fetchTokenStats + LoadState（loading/ok/empty/error）；详情 panel 与首页 widget
 *   复用同一套查询——widget 不再自己 fetch 一套（v0.0.240 教训：widget 传 scope='__team__' 未转 team
 *   导致今日空数据 + 累计取 budget.consumed 与详情 Σ series 口径不一致）。
 * 边界：纯数据 hook；不持业务 UI state（granularity/scope/model 等由调用方传；availableModels 同步、
 *   modelSelection 重置也由调用方处理）；503（sqlite 未就绪）→ empty 降级。
 */
import { useEffect, useState } from 'react';
import { fetchTokenStats } from '../../lib/squad-api';
import type { TokenUsageQueryResult } from './component-token-stats-types';

export type TokenStatsLoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: TokenUsageQueryResult }
  | { kind: 'empty'; reason: string }
  | { kind: 'error'; message: string };

export interface UseSquadTokenStatsOpts {
  from?: string;
  to?: string;
  /** 'team'（Σ 全 member）或 memberId；调用方负责把 '__team__' 转 'team'（与详情 panel 同口径） */
  scope?: string;
  granularity?: 'day' | 'hour';
  providerId?: string;
  modelId?: string;
}

/**
 * fetch squad token 用量时序（一套统计，panel + widget 共用）。
 * opts 任一字段变化 → 重新 fetch；503（sqlite 未就绪）→ empty，其他错误 → error。
 */
export function useSquadTokenStats(squadId: string, opts: UseSquadTokenStatsOpts): TokenStatsLoadState {
  const { from, to, scope, granularity, providerId, modelId } = opts;
  const [state, setState] = useState<TokenStatsLoadState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void fetchTokenStats(squadId, { from, to, scope, granularity, providerId, modelId })
      .then((data) => {
        if (cancelled) return;
        setState({ kind: 'ok', data });
      })
      .catch((err: Error & { status?: number }) => {
        if (cancelled) return;
        if (err.status === 503) {
          setState({ kind: 'empty', reason: '统计功能未就绪（SQLite 未装配）' });
          return;
        }
        setState({ kind: 'error', message: err.message ?? '加载失败' });
      });
    return () => {
      cancelled = true;
    };
  }, [squadId, from, to, scope, granularity, providerId, modelId]);
  return state;
}
