/**
 * config loader — 从 process.env 读取 v0.0.1 server 运行所需配置
 * 参考: specs/tech/app/envs/[P0]environments.md §3.1（共通键）/ §4.6（DATA_DIR 回退规则）
 *
 * 规则：
 *   - APP_NAME 默认 rocky_agent
 *   - API_PORT / WEB_PORT 解析为 number
 *   - DATA_DIR 未设时回退 ~/.{APP_NAME}_{APP_ENV}
 *   - HEALTH_ENDPOINT / LOG_LEVEL / APP_ENV 透传
 *
 * 唯一消费者：@app/server（v0.0.1）。不引入 electron 依赖。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** server 运行配置（typed） */
export interface ServerConfig {
  /** 应用标识，缺省 rocky_agent（参考 environments.md §3.1） */
  appName: string;
  /** 当前环境：test / dev / prod（参考 environments.md §3.1） */
  appEnv: string;
  /** 后端 HTTP API 端口（Bun.serve 监听） */
  apiPort: number;
  /** 渲染层 Vite dev server 端口（server 不直接用，但需感知做 CORS/校验） */
  webPort: number;
  /** 数据根目录，未显式设则回退 ~/.{APP_NAME}_{APP_ENV}（参考 §4.6） */
  dataDir: string;
  /** 健康检查路径（HEALTH_ENDPOINT，默认 /health） */
  healthEndpoint: string;
  /** 日志级别 */
  logLevel: string;
}

/**
 * 展开 path 中的前导 `~` 为 home 目录。
 * shells 在 source .env 时不会展开 `~`（spec §3.5 示例的 `DATA_DIR=~/.rocky_agent_*` 是字面值），
 * server 显式做这层展开，让「显式设」与「回退派生」两路产出相同绝对路径。
 */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * 仅解析 DATA_DIR（v0.0.51 抽出供 memory/skill 等子系统在不启动完整 server config 时复用）。
 * 规则：env.DATA_DIR 未设 → 回退 ~/.{APP_NAME}_{APP_ENV}（environments.md §4.6）。
 * 不依赖 API_PORT/WEB_PORT，可在工具 UT 环境下安全调用。
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const appName = env.APP_NAME ?? 'rocky_agent';
  const appEnv = env.APP_ENV ?? 'test';
  return expandTilde(env.DATA_DIR ?? join(homedir(), `.${appName}_${appEnv}`));
}

/** 把字符串解析为整数端口；非法/缺失抛错 */
function parsePort(raw: string | undefined, key: string): number {
  if (raw === undefined || raw === '') {
    throw new Error(`config: 缺失必需环境变量 ${key}（见 environments.md §3.1）`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`config: ${key}="${raw}" 不是合法端口（1-65535）`);
  }
  return n;
}

/**
 * 从 process.env 构造 ServerConfig。
 * DATA_DIR 未设时回退到 ~/.{APP_NAME}_{APP_ENV}（environments.md §4.6）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const appName = env.APP_NAME ?? 'rocky_agent';
  const appEnv = env.APP_ENV ?? 'test';
  return {
    appName,
    appEnv,
    apiPort: parsePort(env.API_PORT, 'API_PORT'),
    webPort: parsePort(env.WEB_PORT, 'WEB_PORT'),
    dataDir: resolveDataDir(env),
    healthEndpoint: env.HEALTH_ENDPOINT ?? '/health',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

/**
 * 进程级 config 单例缓存。
 * 不在模块顶层立即求值（会让 vitest 在缺 env 时崩溃）；
 * 由 server 入口显式调 getConfig() 触发一次。
 */
let _config: ServerConfig | null = null;

/** 取进程级单例 config，首次调用求值（入口在 env 就绪后调） */
export function getConfig(): ServerConfig {
  if (_config === null) _config = loadConfig();
  return _config;
}
