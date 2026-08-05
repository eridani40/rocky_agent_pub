/**
 * resolveLoadTarget — 决定 BrowserWindow 加载 dev URL 还是 packaged 静态文件
 * 参考: specs/tech/app/package/[P0]package_structure.md §4.3
 *
 * 抽成纯函数（而非塞进 main.ts 内联）的原因：让 v0.0.1「dev 走 vite dev server
 * URL、packaged 走 loadFile」这一关键决策点可单测，无需拉起 Electron runtime。
 * main.ts 作为薄壳调用本函数后据此调 loadURL / loadFile。
 *
 * 后端启动决策（本 task 起）：见 backend-bootstrap.ts。
 *   - dev：外部 bun 进程跑后端，vite proxy 转发 /counter。
 *   - packaged：主进程 node:http 起 @app/server（server 已 runtime-portable，
 *     不再依赖 Bun.serve）。渲染层用 VITE_API_BASE 绝对 URL fetch 后端。
 */

/** dev server 加载目标 */
export interface UrlTarget {
  kind: 'url';
  /** dev server 完整 URL（含 scheme+host+port），来自 VITE_DEV_SERVER_URL */
  url: string;
}

/** packaged 加载目标 */
export interface FileTarget {
  kind: 'file';
  /** web 静态产物 index.html 绝对路径 */
  path: string;
}

/** BrowserWindow 加载目标联合类型 */
export type LoadTarget = UrlTarget | FileTarget;

/**
 * 根据环境与 web 静态产物根目录，决定 BrowserWindow 的加载目标。
 *
 * @param env 进程环境（main.ts 传 process.env；测试可注入）
 * @param webDistDir packaged 时 web 静态产物的绝对根目录
 * @returns 有 VITE_DEV_SERVER_URL（非空）→ url 目标；否则 → file 目标
 */
export function resolveLoadTarget(
  env: NodeJS.ProcessEnv,
  webDistDir: string,
): LoadTarget {
  const devUrl = env.VITE_DEV_SERVER_URL;
  if (devUrl && devUrl.trim() !== '') {
    return { kind: 'url', url: devUrl };
  }
  // 拼接 index.html；webDistDir 末尾可能带 / 也可能不带，用末段剥离再 join 避免双斜杠
  const base = webDistDir.endsWith('/') ? webDistDir.slice(0, -1) : webDistDir;
  return { kind: 'file', path: `${base}/index.html` };
}
