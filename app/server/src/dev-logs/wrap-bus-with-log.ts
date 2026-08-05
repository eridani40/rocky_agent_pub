/**
 * wrapBusWithLog - wrap an EventBus with an emit interceptor that writes events to logs/event.log.
 * Ref: specs/tech/dev-logs/[P0]overall.md §3.4 (event emit hook).
 *
 * v0.0.30 hotfix: the proxy must be MECHANISTICALLY consistent with the real bus interface.
 * The first version hand-enumerated { emit, subscribe, wakePendingSubscribers } and cast
 * `as unknown as Bus`, which MISSED clearReplay (and isReplayable, subscriberCount, ...).
 * The agent loop calls bus.clearReplay(...) during a run, so every run crashed with
 * "clearReplay is not a function" -> SERVER_ERROR.
 *
 * Fix: a JS Proxy whose get trap forwards EVERY property to inner by default, intercepting
 * only `emit`. This is structurally unable to miss a method, whatever the caller invokes.
 * Cost: one lightweight get trap per property access (same indirection as any wrap); the
 * log write itself is gated (LogWriter.write early-returns when the switch is off) and
 * wrapped in try/catch so logging can never affect the emit main flow.
 */
import type { EventBusLike } from '../agent/event-hub';
import type { EventBusEvent } from '../agent/event-bus';
import type { LogWriter } from './log-writer';

/**
 * Wrap inner bus with an emit-intercepting proxy (forwards all methods, intercepts emit only).
 *
 * @param inner     the real bus (ReplayableEventBus instance)
 * @param logWriter LogWriter singleton (write('event', ...) on emit; early-returns if switch off)
 * @param topic     the bus topic (closed over; the bus itself does not know it - spec §3.4)
 * @returns a proxy mechanistically equivalent to inner (emit intercepted for logging; rest forwarded)
 */
export function wrapBusWithLog<Bus extends EventBusLike>(
  inner: Bus,
  logWriter: LogWriter,
  topic: string,
): Bus {
  return new Proxy(inner as object, {
    get(target, prop, receiver) {
      // Sole interception point: emit - log (fail-silent) then delegate to inner.emit.
      if (prop === 'emit') {
        return function (group: string, event: EventBusEvent<unknown>): void {
          try {
            logWriter.write('event', { topic, group, event: event?.data });
          } catch {
            // logging failure must never affect the emit main flow
          }
          return Reflect.apply(Reflect.get(target, 'emit'), target, [group, event]);
        };
      }
      // [REPLAY-DEBUG] subscribe：回放不经过 emit（subscribe 内部直接灌 buffer 给新订阅者），
      //   故单独拦截记录——这是「切回时到底回放了几条」的唯一证据点。bufferLen 透传 inner 取真实值。
      if (prop === 'subscribe') {
        return function (group: string): unknown {
          let len = -1;
          try {
            const bufLenFn = Reflect.get(target, 'bufferLen') as ((g: string) => number) | undefined;
            len = typeof bufLenFn === 'function' ? bufLenFn.call(target, group) : -1;
          } catch { /* ignore */ }
          try {
            logWriter.write('event', { topic, group, event: { type: 'bus_subscribe', bufferLen: len } });
          } catch {
            // logging failure must never affect subscribe main flow
          }
          return Reflect.apply(Reflect.get(target, 'subscribe'), target, [group]);
        };
      }
      // [REPLAY-DEBUG] clearReplay：记录清掉了几条（看前段是不是被清没的）。
      if (prop === 'clearReplay') {
        return function (group: string): unknown {
          let len = -1;
          try {
            const bufLenFn = Reflect.get(target, 'bufferLen') as ((g: string) => number) | undefined;
            len = typeof bufLenFn === 'function' ? bufLenFn.call(target, group) : -1;
          } catch { /* ignore */ }
          const ret = Reflect.apply(Reflect.get(target, 'clearReplay'), target, [group]);
          try {
            logWriter.write('event', {
              topic, group,
              event: { type: 'bus_clearReplay', clearedLen: len },
            });
          } catch {
            // logging failure must never affect clearReplay main flow
          }
          return ret;
        };
      }
      // Everything else (wakePendingSubscribers / isReplayable / subscriberCount /
      // bufferLen / future methods) is forwarded to inner - mechanistically consistent
      // with the real bus interface, unable to miss a method.
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as Bus;
}
