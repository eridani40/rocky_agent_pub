/**
 * runtime-config — packaged Electron 运行时配置注入（修 packaged app 后端起不来的真 bug）
 * 参考: specs/tech/app/package/[P0]packaging_toolchain.md §3.6（runtime-config 注入机制）
 *       specs/tech/app/envs/[P0]environments.md §3.1（共通键）
 *       specs/tech/app/package/[P0]package_structure.md §4.3（main/preload 契约）
 *
 * 为什么需要它：
 *   dev 模式下应用由 scripts/run-dev.sh `source dev.env` 后启动，process.env 已带
 *   API_PORT/DATA_DIR 等；而 build-dmg.sh 的 `source prod.env` 只作用于 build 期
 *   （喂 electron-builder 版本/签名/产物名）。packaged app 被用户双击启动时，进程
 *   环境是干净的（不继承任何 shell env），process.env 里没有 API_PORT ——
 *   backend-bootstrap.resolveServerOpts 读不到 API_PORT 即抛错，后端起不来、前端白屏。
 *
 *   故 build 期把【白名单非密钥键】写进 runtime-config.json 打进 asar，packaged
 *   运行时由本函数在 main 最早期读入并回填 process.env，后端才拿得到 API_PORT。
 *
 * 零密钥硬约束（安全红线）：
 *   只注入 RUNTIME_CONFIG_WHITELIST 中显式列出的键（白名单，非黑名单）。即便 config
 *   文件里意外混入了密钥键（LLM key / 苹果签名 / CSC），本函数也只认白名单、绝不
 *   注入它们。LLM key 等由用户在 app 内配置、落 DATA_DIR，不经 env、不进包。
 */

import { readFileSync } from 'node:fs';

/**
 * 允许注入 process.env 的运行时配置键白名单（零密钥：仅非敏感运行时子集）。
 * 与 scripts/build-dmg.sh 生成 runtime-config.json 的白名单保持一致（两端同源防漂移）。
 */
export const RUNTIME_CONFIG_WHITELIST = [
  'API_PORT',
  'DATA_DIR',
  'APP_NAME',
  'APP_ENV',
  'LOG_LEVEL',
  'HEALTH_ENDPOINT',
  // 卡顿监控开关（非敏感调试键）：build 期从 prod.env 抽入 config，packaged 双击启动
  // 即自动开 event-loop 卡顿自动抓捕（lag 超阈值自动写 .cpuprofile），无需用户手动带 env。
  'EVENT_LOOP_MONITOR',
  'MAIN_EVENT_LOOP_MONITOR',
] as const;

/**
 * 从 configPath 读取运行时配置 JSON，把其中【白名单键】写入 env（不覆盖已有值）。
 *
 * @param env 目标进程环境（main.ts 传 process.env；测试可注入普通对象）
 * @param configPath runtime-config.json 绝对路径（packaged 时在 asar 内）
 * @returns 实际注入的键列表（用于日志/断言）；文件不存在或解析失败 → 返回空数组
 *
 * 语义：
 *   - 只遍历白名单：config 里的非白名单键（含任何密钥）一律忽略（安全红线）。
 *   - 不覆盖已有值：env 里已有该键（dev / 外部注入）→ 保留原值，config 不覆盖。
 *   - 值原样注入：如 DATA_DIR 的字面 `~/.rocky_agent_prod` 原样写入 env，波浪号展开
 *     由 server config 层 expandTilde（按【运行用户】home）负责，不在 electron 层展开
 *     （build-dmg.sh 已把 $HOME 前缀还原成字面 `~`，保证跨用户/机器可移植）。
 *   - 容错静默：文件不存在（dev 模式无此 build 产物）或 JSON 非法 → 返回空、不抛错，
 *     不阻塞 Electron 启动（后端缺 API_PORT 会在 backend-bootstrap 层单独报错）。
 */
export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv,
  configPath: string,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    // 文件不存在（dev）或读取/解析失败 → 静默跳过（不阻塞启动）
    return [];
  }
  // 非对象（null / 数组 / 标量）→ 无可注入键，返回空
  if (parsed === null || typeof parsed !== 'object') return [];
  const config = parsed as Record<string, unknown>;

  const injected: string[] = [];
  for (const key of RUNTIME_CONFIG_WHITELIST) {
    // 已有值不覆盖（dev/外部注入优先）
    if (env[key] !== undefined) continue;
    const val = config[key];
    if (val === undefined || val === null) continue;
    env[key] = String(val);
    injected.push(key);
  }
  return injected;
}
