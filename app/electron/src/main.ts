/**
 * Electron 主进程入口
 * 参考: specs/tech/app/package/[P0]package_structure.md §4.3（main/preload 契约）
 *       specs/tech/app/package/[P0]packaging_toolchain.md §3.3（两段式 build）
 *       本 task 指令（packaged 用 node:http 在 Electron Node 主进程跑后端）
 *
 * 运行时分支：
 *   - dev（VITE_DEV_SERVER_URL 非空）：**不**起后端（dev.env 的 API_START_CMD
 *     用 bun 独立进程跑），BrowserWindow.loadURL(devUrl)，vite proxy 转发 /counter。
 *   - packaged（无 VITE_DEV_SERVER_URL）：app.whenReady → startServer（node:http
 *     on API_PORT，@app/server 已 runtime-portable，Node 主进程可直接 require）
 *     → 创建 BrowserWindow → loadFile(web-dist/index.html)。渲染层用
 *     VITE_API_BASE=http://127.0.0.1:${API_PORT} 绝对 URL fetch 后端（跨域，server CORS 已开）。
 *
 * 不变量（package_structure §3.3）：本文件是唯一 import electron 的入口。
 * server 仅以 require('@app/server') 形式被本进程消费，server 自身零 electron 依赖。
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { resolveLoadTarget } from './resolve-load-target';
import { shouldStartBackend, startBackend } from './backend-bootstrap';
import { registerComputerPermissionsIpc, runComputerSelfCheck } from './computer-permissions-ipc';
import { registerOpenExternalIpc } from './open-external-ipc';
// v0.0.105：computer use 原生能力端口（packaged 直注入 @app/server）+ dev loopback 通道
import { makeElectronComputerNativePort } from './computer-native-port';
import { startComputerLoopbackServer } from './computer-loopback-server';
import { loadRuntimeConfig } from './runtime-config';
// 主进程事件循环卡顿监控（复用 @app/server startEventLoopMonitor；默认关）
import { startMainEventLoopMonitor } from './main-event-monitor';
// packaged 主进程抬 nofile 软上限（256→4096）给基线 fd 余量救急
// "第一次 bash 就坏"的根因之一是 packaged nofile=256 启动期基线逼近上限；bash spawn 在主进程跑
import { raiseNofileLimit } from './raise-nofile';
// v0.0.10：electron 关闭前 flush langfuse SDK 异步 batch（防丢末尾 trace）。
//   动态 require 避免 dev 单测时强依赖 server dist；失败静默（observability 不影响主流程）。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shutdownObservability } = require('@app/server') as {
  shutdownObservability?: () => Promise<void>;
};

/** packaged 时 web 静态产物的根目录（绝对路径）。
 *  约定（见 packaging_toolchain §3.3）：vite build outDir = app/electron/web-dist，
 *  build-dmg.sh 先跑 vite build 产出，再 tsc -b 编译 main，最后 electron-builder。
 *  本文件运行时 main 进程的 __dirname = app/electron/dist，故 web-dist 与 dist 同级。 */
const WEB_DIST_DIR = join(__dirname, '..', 'web-dist');

/** 从 URL 取 `protocol://host:port` origin（will-navigate 放行同 origin dev server 用）；非法 URL 返 null */
function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** preload 编译产物绝对路径（contextIsolation 必须指 preload 文件路径） */
const PRELOAD_PATH = join(__dirname, 'preload.js');

/**
 * 创建主 BrowserWindow 并加载 dev URL 或 packaged 静态文件，返回该窗口实例。
 * 抽函数便于 macOS 重新激活时复用（app 'activate' 事件无窗口时重建）。 */
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Rocky Agent',
    width: 1200,
    height: 800,
    // 地板 = 最宽配置 studio（nav-rail 56 + sidebar 224 + 中部保底 480 + ws-panel 232 = 992）+ 8px 余量；
    // 窗口窄到此值 OS 阻止再缩，栏位无需裁切/横滚。minHeight 配对防纵向过度压缩。
    minWidth: 1000,
    minHeight: 600,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const target = resolveLoadTarget(process.env, WEB_DIST_DIR);
  if (target.kind === 'url') {
    // dev：连 vite dev server（HMR、proxy /counter → 后端）
    void win.loadURL(target.url);
  } else {
    // packaged：加载 vite build 产出的静态 index.html（后端由主进程 node:http 跑起）
    void win.loadFile(target.path);
  }
  // v0.0.253：兜底拦截所有 renderer 侧 navigate（package_structure §4.4 不变量3）
  //   (a) setWindowOpenHandler 兜底所有 target=_blank / window.open() → 转 shell.openExternal，
  //       禁开新 Electron 窗口（点 markdown 链接 http → 系统浏览器）。
  //   (b) will-navigate 拦截 href 改动导航，仅放行同 origin dev server（VITE_DEV_SERVER_URL HMR 跳转），
  //       其它一律 preventDefault + 转 openExternal。
  win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    void shell.openExternal(openUrl);
    return { action: 'deny' };
  });
  const devOrigin = target.kind === 'url' ? safeOrigin(target.url) : null;
  win.webContents.on('will-navigate', (event, navUrl) => {
    if (devOrigin && safeOrigin(navUrl) === devOrigin) return; // dev server HMR / 路由跳转放行
    event.preventDefault();
    void shell.openExternal(navUrl);
  });
  // --debug（run-dev.sh --debug → ROCKY_OPEN_DEVTOOLS=1）：窗口创建即开 devtools（detach），
  // 让 SSE agent_loop 连接建立时 devtools 已就位 → Network/EventSource 面板能捕捉完整 event 流
  // （否则 devtools 后开，已建立的 EventSource 不显示）。用于排查「丢中间 message」类流式问题。
  if (process.env.ROCKY_OPEN_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  return win;
}

// 单实例锁定 + ready 后起窗口；macOS dock 激活时若无窗口重建。
// packaged 模式在起窗口前先 startServer（node:http），让渲染层 loadFile 后即可 fetch 后端。
void (async () => {
  // [v0.0.317] dev APP_NAME 隔离：dev 和 prod 用同一 Electron app bundle（同一 package.json），
  //   macOS 通过 app.name 做进程/窗口管理，不隔离会导致 dev 启动影响 prod 窗口（白屏）。
  //   dev 模式（shouldStartBackend=false）时显式 setName(APP_NAME)，
  //   让 macOS 认为是不同 app（如 rocky_agent_dev vs packaged 的 rocky_agent）。
  //   必须在 app.whenReady() 之前调用才生效。
  if (!shouldStartBackend(process.env) && process.env.APP_NAME) {
    app.setName(process.env.APP_NAME);
  }

  // 单实例锁（packaged only）：后端跑在主进程内 node:http 监听 API_PORT，第二个实例会
  // 撞 EADDRINUSE → 后端起不来 → 白屏。拿不到锁说明已有实例在跑，直接退出并把已有窗口聚焦。
  // dev 模式（shouldStartBackend=false，不起后端）无端口冲突，允许多实例、跳过锁。
  if (shouldStartBackend(process.env)) {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return;
    }
    app.on('second-instance', () => {
      const [win] = BrowserWindow.getAllWindows();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }

  // 最早期注入运行时配置：packaged app 被用户双击启动时 process.env 是干净的
  // （不继承 shell env），必须先从打进 asar 的 runtime-config.json 回填 API_PORT/
  // DATA_DIR 等，否则 backend-bootstrap 读不到 API_PORT → 后端起不来 → 前端白屏。
  // 只注入非密钥白名单键（见 runtime-config.ts）；dev 模式无此 build 产物 → 静默返回空。
  const injectedKeys = loadRuntimeConfig(
    process.env,
    join(__dirname, '..', 'runtime-config.json'),
  );
  if (injectedKeys.length > 0) {
    // eslint-disable-next-line no-console
    console.log('[electron] runtime-config injected:', injectedKeys.join(', '));
  }

  // 主进程事件循环卡顿监控（默认关，MAIN_EVENT_LOOP_MONITOR=1 开；失败静默，绝不影响启动）。
  //   必须在 loadRuntimeConfig 之后：packaged 下 DATA_DIR 由 runtime-config 注入，
  //   监控的 profile 目录经 resolveDataDir(process.env) 派生。packaged 下主进程内嵌后端，
  //   server 侧监控（EVENT_LOOP_MONITOR）与本监控采样同一 event loop——勿双开重复抓。
  startMainEventLoopMonitor(process.env);

  // 抬 nofile soft 到 4096（packaged 默认 256 给基线 fd 余量救急）。
  // 必须在 startBackend 前 raise：bash 工具 spawn 在主进程跑，启动后即用新 limit。
  // 时序=runtime-config → raise-nofile → startBackend。dev ulimit 已 1048576，取 max 无副作用。
  // 容错在 raiseNofileLimit 内部（posix 缺失/失败静默不阻塞启动），main 不加额外 catch。
  const nofileResult = raiseNofileLimit(4096);
  // eslint-disable-next-line no-console
  console.log('[electron] nofile soft:', nofileResult);

  const packaged = shouldStartBackend(process.env);
  // packaged 模式：在 app ready 前起后端（node:http on API_PORT）+ 直注入 ComputerNativePort。
  // dev 模式 shouldStartBackend=false，跳过起后端（后端由独立 bun 进程跑，原生能力走 loopback 通道）。
  if (packaged) {
    try {
      await startBackend(process.env);
      // v0.0.105：packaged server 在主进程内 → 直接注入 ComputerNativePort（首个请求前 set，时序安全；
      // port 方法 lazy 用 electron/native addon，仅在 tool 运行时调，远晚于 whenReady）。
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { setComputerNativePort } = require('@app/server') as {
        setComputerNativePort?: (p: unknown) => void;
      };
      setComputerNativePort?.(makeElectronComputerNativePort());
    } catch (e) {
      // 后端起不来不应阻塞 UI；记日志让用户/开发者感知（计数器会 fetch 失败）
      // eslint-disable-next-line no-console
      console.error('[electron] startServer failed:', e);
    }
  }

  await app.whenReady();

  // [preload fix] sandboxed preload 不能 require('electron').app（app 为 undefined），
  // 用 IPC 桥：preload 调 invoke('app:get-version')，主进程在 app 上下文里返 getVersion()。
  ipcMain.handle('app:get-version', () => app.getVersion());

  // v0.0.105 spike：注册 computer 权限/截图 IPC（原生能力在主进程内，共享 Rocky TCC 身份）。
  registerComputerPermissionsIpc();
  // v0.0.253：注册通用打开外部资源 IPC（openExternal / openPath / readFileText）。
  registerOpenExternalIpc();
  // 启动自检：仅做非侵入权限态查询（不弹窗），在 stdout 打印 Rocky 当前授权态便于诊断。
  // **绝不主动触发权限请求**——截图（首次会触发屏幕录制请求）只由用户点「测试截图」触发。
  runComputerSelfCheck();

  // v0.0.105 P0-G：dev 模式起 computer loopback 通道（whenReady 后，native addon 主进程内加载）。
  //   让独立 bun 后端的 agent computer 工具纯 fetch 走通到主进程 native addon（ScreenCaptureKit + AX +
  //   postToPid，dev 可验闭环）；仅 ROCKY_DEV_COMPUTER_LOOPBACK_PORT 有值才激活；packaged 不走（上面已直注入）。
  if (!packaged) {
    startComputerLoopbackServer(process.env);
  }

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
})();

// 非 macOS 平台窗口全关时退出（macOS 留 dock）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// v0.0.10：app 退出前 flush observability（langfuse SDK 异步 batch，不 flush 会丢末尾 trace）。
//   before-quit 暂停退出 → await flush → app.exit(0) 真正退出。
//   NoopAdapter 时 shutdown 为 noop（零成本）；flush 失败静默（核心红线：observability 不影响退出）。
let observabilityFlushed = false;
app.on('before-quit', (event) => {
  if (observabilityFlushed || !shutdownObservability) return;
  event.preventDefault(); // 暂停退出，等异步 flush
  observabilityFlushed = true;
  void (async () => {
    try {
      await shutdownObservability();
    } catch {
      // 静默：flush 失败不阻塞退出
    }
    app.exit(0); // flush 完真正退出（再次触发 before-quit，但 observabilityFlushed=true 直通）
  })();
});
