/**
 * hang-sink —— 事件循环卡顿 episode 结构化记录上报通道（engine/runtime 无关）
 * 参考: specs/tech/agent/observability/[P1]hang_monitor.md（卡顿监控 spec）
 *       app/server/src/persistence/slow-query.ts（同范式：底座层模块级 sink）
 *
 * 设计要点：
 *   - **底座不反向依赖上层**：observability 是底座层，不 import dev-logs（LogWriter 在上层）。
 *     本模块只定义 sink 接口 + 模块级注册点，由 bootstrap（上层组合根）注入
 *     `record => logWriter.write('performance', record)`。依赖方向保持 上层 → 底座
 *     （同 setSlowQuerySink 范式）。
 *   - **零开销**：sink 未注册时 reportHang 短路（仅判 _sink 一次）。sink 已注册但性能日志
 *     开关 false 时由 LogWriter.write 内部门禁早 return（spec dev-logs §2.4），调用方零感知。
 *   - **ts 字段不在 record**：由 LogWriter 补；profileFile 在 record 内（grep kind:hang
 *     → 路径 → 拖入 DevTools，无需翻日志找文件名）。
 *   - **kind:'hang'** 与 SlowQueryInfo 的 kind:'slowquery' 对称——`grep kind:` 统一筛
 *     performance.log 中不同来源记录。
 */

/**
 * 一条卡顿 episode 记录（落 performance.log 的业务字段；ts 由 LogWriter 补）。
 * 用 type 而非 interface：type 别名有隐式 index signature，可直接传给
 * LogWriter.write 的 Record<string, unknown> 参数（interface 不行，同 SlowQueryInfo）。
 *
 * phase='enter' 携带完整指标（lagMs/cpuUserMs/cpuSysMs/elu/profileFile?），
 * phase='recover' 仅带 source（退出信号，无当前快照——避免误导读者以为这是新的卡顿）。
 */
export type HangRecord = {
  /** 记录类别（与 slowquery 对称，统一筛 performance.log） */
  kind: 'hang';
  /** episode 阶段：进入卡顿 / 从卡顿恢复 */
  phase: 'enter' | 'recover';
  /** 来源标识（profile 文件名前缀 + 日志 tag，与 startEventLoopMonitor source 一致） */
  source: string;
  /** 本周期最坏事件循环延迟（毫秒，取整；仅 enter 阶段） */
  lagMs?: number;
  /** 用户态 CPU 耗时增量（毫秒，取整；仅 enter 阶段） */
  cpuUserMs?: number;
  /** 内核态 CPU 耗时增量（毫秒，取整；仅 enter 阶段） */
  cpuSysMs?: number;
  /** event loop utilization 增量（仅 enter 阶段） */
  elu?: number;
  /** CPU profile 文件路径（与 warn tsIso 同源派生；无 profileDir 时缺省。仅 enter 阶段） */
  profileFile?: string;
};

/** 卡顿上报通道（上层注入；void 签名 = fire-and-forget，绝不阻塞采样 tick） */
export type HangSink = (record: HangRecord) => void;

/** 模块级 sink（进程内唯一；bootstrap 装配一次，未注册 = 完全不产出卡顿日志） */
let _sink: HangSink | null = null;

/**
 * 注册卡顿 sink（bootstrap 组合根在 LogWriter 就绪后调一次）。
 * 传 null 注销（UT 隔离用）。幂等：重复调覆盖前值。
 */
export function setHangSink(sink: HangSink | null): void {
  _sink = sink;
}

/**
 * 上报一条卡顿记录。供 event-loop-monitor tick() 调用。
 * sink 未注册时短路（零副作用）；sink 已注册时同步调用（write = O(1) stringify + enqueue）。
 * 不做 try/catch：sink 内异常由调用方（tick 的 try/catch）兜底，本模块是观测底座不吞错。
 */
export function reportHang(record: HangRecord): void {
  if (!_sink) return;
  _sink(record);
}
