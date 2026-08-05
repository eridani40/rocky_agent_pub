/**
 * slow-query —— CrudStore.query 慢查询性能日志埋点（engine 无关）
 * 参考: reqs/[working] v0.0.257/req.md（三条硬约束：异步化不加剧延迟 / 队列有界太长就放弃 /
 *       开关在 app config 可观测性）
 *
 * 设计要点：
 *   - **底座不反向依赖上层**：persistence 是底座层，不 import dev-logs（LogWriter 在上层）。
 *     本模块只定义 sink 接口 + 模块级注册点，由 bootstrap（上层组合根）注入
 *     `info => logWriter.write('performance', info)`。依赖方向保持 上层 → 底座。
 *     与 setSessionStoreEpDelegate / setTokenUsageSubscriberDeps 同范式（模块级注入）。
 *   - **零开销**：sink 未注册时 query 仅多一次 nowMs() 调用；sink 已注册但开关 false 时
 *     LogWriter.write 内部零开销门禁早 return（spec dev-logs §2.4），调用方零感知。
 *   - **异步不阻塞主路径**（req 硬约束 1）：sink 适配到 LogWriter.write = O(1) stringify
 *     + enqueue，单 consumer 异步 appendFile，查询主路径零磁盘 IO。
 *   - **队列有界太长就放弃**（req 硬约束 2）：500MB drop-new + 失败静默由 LogQueue 内建，
 *     本模块不重复实现。
 */
import type { QueryFilter } from './crud-types';
import type { SchemaDef } from './schema-types';

/**
 * 慢查询阈值（毫秒）。先固定常量（req 裁决：参数化留注释，后续版本可接 app_config）。
 * 注意阈值判断用严格大于：耗时恰好等于阈值不算慢。
 */
export const SLOW_QUERY_MS = 200;

/** 一条慢查询记录（落 performance.log 的业务字段；ts 由 LogWriter 补）。
 *  用 type 而非 interface：type 别名有隐式 index signature，可直接传给
 *  LogWriter.write 的 Record<string, unknown> 参数（interface 不行）。 */
export type SlowQueryInfo = {
  /** 记录类别（与 HangRecord 的 kind:'hang' 对称——`grep kind:` 统一筛 performance.log） */
  kind: 'slowquery';
  /** engine 标识（fs 全扫 / sqlite） */
  engine: 'fs' | 'sqlite';
  /** 实体名（schema.entity）——定位「哪个实体卡」的核心字段 */
  entity: string;
  /** 分片键（filter.shardKey；不分片或 scatter 全 shard 为 null） */
  shardKey: string | null;
  /** 查询耗时（毫秒，取整） */
  ms: number;
  /** 返回记录数（过滤 + limit 后调用方真实拿到的条数，反映扫描工作量） */
  count: number;
  /** 原始 filter（排查复现用；QueryFilter 全字段可 JSON 序列化） */
  filter: QueryFilter;
};

/** 慢查询上报通道（上层注入；void 签名 = fire-and-forget，绝不阻塞查询主路径） */
export type SlowQuerySink = (info: SlowQueryInfo) => void;

/** 模块级 sink（进程内唯一；bootstrap 装配一次，未注册 = 完全不产出慢日志） */
let _sink: SlowQuerySink | null = null;

/**
 * 注册慢查询 sink（bootstrap 组合根在 LogWriter 就绪后调一次）。
 * 传 null 注销（UT 隔离用）。
 */
export function setSlowQuerySink(sink: SlowQuerySink | null): void {
  _sink = sink;
}

/**
 * 包一层 query 计时：执行 fn → 耗时超 SLOW_QUERY_MS 上报 sink。
 *
 * sink 未注册时短路（仅一次 nowMs() 开销，不构造任何对象）；
 * sink 已注册但性能日志开关 false 时由 LogWriter 门禁拦截（此处无感知）。
 *
 * @param engine engine 标识（写入记录，区分 fs / sqlite）
 * @param schema 查询的 schema（取 entity）
 * @param filter 原始 filter（取 shardKey + 落盘供复现）
 * @param fn     原查询（同步语义，与 CrudStore.query 契约一致）
 * @param nowMs  毫秒时钟（engine 构造注入，UT 可控；生产用 Date.now）
 * @returns fn 的返回值（原样透传，零行为变更）
 */
export function queryWithSlowLog<R extends unknown[]>(
  engine: 'fs' | 'sqlite',
  schema: SchemaDef,
  filter: QueryFilter,
  fn: () => R,
  nowMs: () => number,
): R {
  const t0 = nowMs();
  const records = fn();
  // sink 未注册：跳过第二次计时与一切对象构造（零开销短路）
  if (!_sink) return records;
  const ms = nowMs() - t0;
  if (ms > SLOW_QUERY_MS) {
    _sink({
      kind: 'slowquery',
      engine,
      entity: schema.entity,
      shardKey: filter.shardKey ?? null,
      ms: Math.round(ms),
      count: records.length,
      filter,
    });
  }
  return records;
}
