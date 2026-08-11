/**
 * use-squad-meta —— Studio sidebar squad 聚合状态订阅（squad_meta SSE）
 * 参考: specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/architecture.md D6
 *       specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/change_plan.md D 组
 *       use-studio-unread-meta.ts（同构模式：useLifecycle + applyKeyed + onResumed）
 *
 * 职责：page-studio 级单例订阅 `squad_meta _all` 广播；
 *   维护 aggregateMap: KeyedMap<squadId, SquadAggregate>（onlineCount/inProgressCount/lastActiveAt）。
 *   onEvent squad_meta_update → applyKeyed set 整条替换；
 *   onResumed → reloadSquads 断连兜底（对齐 session_meta §10.3 模式）。
 *   初始态由 page-studio squads（GET /squad）提供，本 hook 不拉 GET。
 */
import { useRef } from 'react';
import { useLifecycle } from '../../lib/use-lifecycle';
import { applyKeyed, type KeyedMap } from '../../lib/lifecycle-shapes';
import { getSseClient } from '../../lib/sse-singleton';

/** 前端 SquadAggregate 类型（与后端 squad-event-types.ts 同构） */
export interface SquadAggregate {
  squadId: string;
  onlineCount: number;
  inProgressCount: number;
  lastActiveAt: string;
}

/** hook ctx：KeyedMap 聚合数据 */
export interface SquadMetaCtx {
  aggregateMap: KeyedMap<string, SquadAggregate>;
}

/** hook 暴露态 */
export interface SquadMeta {
  aggregateMap: Record<string, SquadAggregate>;
}

/** 空 ctx（onInit 用） */
function emptyCtx(): SquadMetaCtx {
  return { aggregateMap: {} as KeyedMap<string, SquadAggregate> };
}

/**
 * 订阅 squad_meta `_all` 广播，维护 aggregateMap。
 * 数据唯一归 ctx（KeyedMap）：SSE 帧经 onEvent 纯 reducer 写入。
 * onResumed 注册 reloadSquads 断连兜底（防漏帧）。
 */
export function useSquadMeta(opts: { reloadSquads: () => Promise<void> }): SquadMeta {
  // 用 ref 保持 reloadSquads 最新引用（onResumed 注册一次，回调内读 ref）
  const reloadRef = useRef(opts.reloadSquads);
  reloadRef.current = opts.reloadSquads;

  const { ctx } = useLifecycle<SquadMetaCtx, { type: string; data?: SquadAggregate }>({
    onInit: (api) => {
      api.subscribe('squad_meta', '_all');
      // onResumed 断连兜底：SSE 重连后全量拉 GET /squad（对齐 session_meta §10.3）
      // 注册一次（onInit 仅调一次）；回调读 ref 保持最新引用
      getSseClient().onResumed(() => {
        void reloadRef.current();
      });
      return emptyCtx();
    },
    onEvent: (ctx, evt) => {
      if (!ctx) return;
      const incoming = evt?.data;
      if (!incoming || !incoming.squadId) return ctx;
      // squad_meta_update → 按 data.squadId 整条替换（applyKeyed set 幂等）
      const next = applyKeyed(ctx.aggregateMap, {
        op: 'set',
        key: incoming.squadId,
        value: incoming,
      });
      if (next === ctx.aggregateMap) return ctx; // 无变化跳渲染
      return { aggregateMap: next };
    },
    deps: [],
  });

  const fallback = emptyCtx();
  return {
    aggregateMap: ctx?.aggregateMap ?? fallback.aggregateMap,
  };
}
