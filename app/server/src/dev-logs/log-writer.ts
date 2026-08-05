/**
 * LogWriter —— dev 调试日志落盘模块（7 个开关各写一个 JSONL 文件，含 performance 慢查询日志）
 * 参考: specs/tech/dev-logs/[P0]overall.md §2（LogWriter 模块）+ §2.3（fire-and-forget）+ §2.4（零开销门禁）
 *       specs/tech/version_logs/v0.0.138/change_plan.md §改造#1（生产者消费者 + 500MB drop-new）
 *
 * 设计要点：
 *   - **零开销门禁在 write 内部**（spec §2.4）：每次 write 先读 appConfig 开关，false → 早 return
 *     （不构造 JSON、不读文件、不开 IO）。开关读取走 appConfig service（KV cheap），保证用户
 *     在 UI 改开关后下一次 write 立即生效（无需重启）。
 *   - **生产者消费者**：write 同步 stringify → enqueue（O(1)，不含 IO），consumer loop
 *     后台按批 appendFile。fire-and-forget（同步返 void），落盘延迟 ≥ BATCH_INTERVAL_MS=250ms。
 *   - **追加写不覆盖**：appendFile `{flag:'a'}`（spec §2.3；在 log-queue consumer 内）。
 *   - **fire-and-forget + 失败静默**（spec §2.3）：write 返 void，consumer loop 失败 catch 吞掉。
 *   - **不做轮转/截断/控制台输出**（spec §6 scope 外）。
 *
 * 历史：v0.0.89 dev_config 废弃前构造参数名为 devConfig（读 dev_config.logs）；
 * 迁移后 group/key 名零变更直迁 app_config.logs，参数改名 appConfig。
 *
 * 单例：模块级 `getLogWriter(dataDir, appConfig)` 缓存实例（首次 ensure 目录）。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LogQueue } from './log-queue';

/** 日志类型 → 文件名（performance = 慢查询性能日志） */
export type LogType = 'llm' | 'tool' | 'api' | 'event' | 'error' | 'agent' | 'performance';

/** 日志类型 → appConfig key 映射（spec §2.4 TYPE_TO_KEY；v0.0.89 自 dev_config 迁入） */
const TYPE_TO_KEY: Record<LogType, string> = {
  llm: 'enableLlmRequestLog',
  tool: 'enableToolResultLog',
  api: 'enableAppApiLog',
  event: 'enableEventLog',
  error: 'enableErrorLog',
  agent: 'enableAgentLog',
  performance: 'enablePerformanceLog',
};

/**
 * LogWriter —— 把一条结构化记录序列化为一行 JSON 追加写入 `<DATA_DIR>/logs/<type>.log`。
 *
 * 门禁在 write 内部：开关 false 时早 return（零开销，调用方无需判断开关，直接调 write）。
 */
export class LogWriter {
  /** 有界消费者队列（单实例，constructor 创建） */
  private readonly queue: LogQueue;

  /**
   * @param dataDir   DATA_DIR 绝对路径（logs 写到 `<dataDir>/logs/`）
   * @param appConfig AppConfigService（读 logs group 开关；鸭子类型，只需 get(group, key)）
   */
  constructor(
    private readonly dataDir: string,
    private readonly appConfig: { get(group: string, key: string): unknown },
  ) {
    // 启动期 ensure logs 目录（mkdir recursive，失败静默不阻塞启动）
    try {
      mkdirSync(join(dataDir, 'logs'), { recursive: true });
    } catch {
      // 已存在或权限：忽略（write 时再报也只在 catch 内吞，不影响业务）
    }
    // 有界消费者队列（lazy 启 loop on first enqueue）
    this.queue = new LogQueue(dataDir);
  }

  /**
   * 写一条记录；对应开关 false 时早 return（不构造 JSON、不读文件、不开 IO）。
   *
   * 生产者：同步 stringify（architect 决策，理由见 change_plan §改造#1）→ enqueue（O(1) 不含 IO）。
   * 消费者后台按批 appendFile（spec §2.3 fire-and-forget；失败静默）。
   *
   * @param type   日志类型（决定文件名 + 开关 key）
   * @param record 业务字段（不含 ts，内部补 ISO8601 ts）
   */
  write(type: LogType, record: Record<string, unknown>): void {
    // 零开销门禁：先读开关，false 直接 return（spec §2.4）
    const enabled = this.appConfig.get('logs', TYPE_TO_KEY[type]);
    if (enabled !== true) return; // 可选覆盖语义：record 缺失或非 true 都视为 false
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    // fire-and-forget：enqueue 同步入队，consumer loop 后台落盘（spec §2.3；失败静默在 consumer）
    this.queue.enqueue(type, line);
  }
}

// ── 模块级单例（spec §2.1：getLogWriter(dataDir, appConfig)） ──

let _instance: LogWriter | null = null;

/**
 * 取（缓存）LogWriter 单例。首次调用 ensure logs 目录 + 缓存 dataDir/appConfig。
 *
 * @param dataDir   DATA_DIR 绝对路径
 * @param appConfig AppConfigService
 * @returns LogWriter 实例（进程级单例）
 */
export function getLogWriter(
  dataDir: string,
  appConfig: { get(group: string, key: string): unknown },
): LogWriter {
  if (!_instance) {
    _instance = new LogWriter(dataDir, appConfig);
  }
  return _instance;
}

/** （仅测试用）重置单例（隔离 UT 间状态） */
export function resetLogWriterForTest(): void {
  _instance = null;
}
