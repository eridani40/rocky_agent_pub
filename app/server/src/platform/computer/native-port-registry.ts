/**
 * native-port-registry —— ComputerNativePort 的 process 级注入 seam（setX 注入范式）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2.md §2 注入链路 + §5 P0-A
 *
 * 为何用 registry setter 而非 startServer opts 透传（§2 注解）：
 *   handleRequest(req, dataDir) 是全局纯函数、bootstrap 按 dataDir 缓存懒建，
 *   而 port 是 process 级单例（一个 Electron 宿主）。透传会污染 handleRequest/getBootstrap 签名；
 *   setter 是最小侵入且对齐既有 per-dataDir bootstrap 单例范式。
 *
 * 时序：packaged 模式 main.ts 在首个请求前 setComputerNativePort(makeElectronComputerNativePort())
 *   → bootstrap 首建时 getComputerNativePort() 读到（§2 时序安全）。
 *   dev/AT 模式不经 registry（走 loopback / mock env 解析，见 bootstrap precedence）。
 */
import type { ComputerNativePort } from './native-port';

/** process 级单例 holder（一个 Electron 宿主一个 port） */
let _port: ComputerNativePort | undefined;

/**
 * 注入主进程 ComputerNativePort 实现（main.ts packaged 分支调用）。
 * @param port electron impl；传 undefined 可清除（测试隔离用）
 */
export function setComputerNativePort(port?: ComputerNativePort): void {
  _port = port;
}

/**
 * 读取已注入的 port（bootstrap packaged 分支消费）。
 * @returns 已注入的 port；未注入（非 electron / dev / AT）→ undefined
 */
export function getComputerNativePort(): ComputerNativePort | undefined {
  return _port;
}
