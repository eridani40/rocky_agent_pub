/**
 * computer-loopback-server —— dev-only 127.0.0.1 通道，把 bun 后端桥到主进程 native addon
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2.md §5.5 P0-G
 *       specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §P1-D（/invoke 泛路由）
 *
 * 为何存在（§5.5 根因）：dev 后端是独立 bun 进程（TS-direct 热重载 DX 资产），够不到 Electron
 *   主进程内加载的 native addon（TCC 权限主体）。方案 D：主进程（dev 也常驻）额外开一个极小
 *   node:http loopback server，bun 后端的 LoopbackComputerNativePort 纯 fetch 走通到主进程。
 *   底层 native 逻辑复用 makeElectronComputerNativePort()（dev/packaged 单一源）。
 *
 * 通道：GET /permissions（专属）+ POST /screenshot（专属）+ POST /invoke {method,params}（泛路由，
 *   getAppState/readAxTree/listApps/click/type/scroll/pressKey/drag/setValue/performSecondaryAction
 *   统一走 /invoke——主进程按 method 分发 `port[method](...params)`，免为每动作开专属端点）。
 *
 * 约束：
 *   - **MUST** 仅 127.0.0.1 bind + token 校验（防同机其他进程误撞原生动作端点）。
 *   - **MUST** 仅 dev 启（main.ts !shouldStartBackend else 分支调）；**MUST NOT** 进 packaged 路径。
 *   - **MUST** 复用 makeElectronComputerNativePort（不重造 native 逻辑）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  makeElectronComputerNativePort,
  type ElectronComputerNativePort,
} from './computer-native-port';

/** dev token header 名（与 LoopbackComputerNativePort 客户端同名） */
const DEV_TOKEN_HEADER = 'x-rocky-dev-token';

/** /invoke 允许分发的 method 白名单（防按 method 名调 port 上任意属性/内部方法） */
const INVOKE_METHODS = new Set<string>([
  'getAppState',
  'readAxTree',
  'listApps',
  'click',
  'type',
  'scroll',
  'pressKey',
  'drag',
  'setValue',
  'performSecondaryAction',
  'screenshot',
]);

/**
 * loopback 请求体（两形态）：
 *   - /invoke → {method, params:位置参数数组}
 *   - /screenshot → ComputerScreenshotOptions（{app?,...}；客户端 JSON.stringify(opts) 直发）
 */
interface LoopbackBody {
  method?: string;
  params?: unknown[];
  app?: string;
}

/**
 * 路由 loopback 请求（纯逻辑，可 UT：注入 fake port + token + body）。
 *   - token 缺/错 → 403（防误撞）
 *   - GET  /permissions → port.checkPermissions()
 *   - POST /screenshot  → port.screenshot(opts)（转发 body 作截图 opts，app hint 定位单窗口）
 *   - POST /invoke      → port[body.method](...body.params)（白名单校验）
 *   - 其他 → 404；port 抛 → 500 + {ok:false,reason}
 *
 * @param body JSON body（/invoke 为 {method,params}；/screenshot 为 opts；GET/无体传 {}）
 * @returns { status, body }（body JSON 序列化返客户端）
 */
export async function routeLoopback(
  method: string | undefined,
  url: string | undefined,
  tokenHeader: string | undefined,
  expectedToken: string,
  port: ElectronComputerNativePort,
  body?: LoopbackBody,
): Promise<{ status: number; body: unknown }> {
  // token 校验：expectedToken 必须非空且严格匹配（缺 token 配置 = 拒绝，fail-closed）
  if (!expectedToken || tokenHeader !== expectedToken) {
    return { status: 403, body: { ok: false, reason: 'forbidden: bad or missing dev token' } };
  }
  const path = (url ?? '').split('?')[0];
  try {
    if (method === 'GET' && path === '/permissions') {
      return { status: 200, body: await port.checkPermissions() };
    }
    if (method === 'POST' && path === '/screenshot') {
      // 转发 opts（app hint 供 native 单窗口截图定位；缺省 frontmost）
      return { status: 200, body: await port.screenshot({ app: body?.app }) };
    }
    if (method === 'POST' && path === '/invoke') {
      return await routeInvoke(port, body);
    }
    return { status: 404, body: { ok: false, reason: `not found: ${method} ${path}` } };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { status: 500, body: { ok: false, reason } };
  }
}

/**
 * /invoke 泛路由分发：白名单校验 method → `port[method](...params)` → JSON 返。
 * 未知 method → 404；params 缺省空数组（各 port 方法 opts 全可选，缺省走 native 默认）。
 */
async function routeInvoke(
  port: ElectronComputerNativePort,
  body?: LoopbackBody,
): Promise<{ status: number; body: unknown }> {
  const name = body?.method;
  if (!name || !INVOKE_METHODS.has(name)) {
    return { status: 404, body: { ok: false, reason: `invoke: unknown method ${name ?? '<none>'}` } };
  }
  const params = Array.isArray(body?.params) ? body.params : [];
  const fn = (port as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name];
  if (typeof fn !== 'function') {
    return { status: 404, body: { ok: false, reason: `invoke: no method ${name}` } };
  }
  return { status: 200, body: await fn.apply(port, params) };
}

/**
 * 读取并 JSON 解析请求体（/invoke 需 params body；GET/无体 → {}，解析失败 → {}，保连接不挂）。
 */
function readJsonBody(req: IncomingMessage): Promise<LoopbackBody> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as LoopbackBody);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** 写 JSON 响应 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/** startComputerLoopbackServer 返回句柄（main.ts 可选持有，app 退出时 close） */
export interface ComputerLoopbackHandle {
  close: () => void;
  port: number;
}

/**
 * 启动 dev loopback server（main.ts dev 分支调，app.whenReady 后）。
 * `ROCKY_DEV_COMPUTER_LOOPBACK_PORT` 无值 → 返 undefined（未激活通道，dev 原生能力降级不可用）。
 *
 * @param env 进程环境（读 loopback port/token）
 * @returns 句柄（含 close）或 undefined（未配置端口）
 */
export function startComputerLoopbackServer(
  env: NodeJS.ProcessEnv,
): ComputerLoopbackHandle | undefined {
  const portStr = env.ROCKY_DEV_COMPUTER_LOOPBACK_PORT;
  if (!portStr || portStr.trim() === '') return undefined;
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined;
  const token = env.ROCKY_DEV_COMPUTER_LOOPBACK_TOKEN ?? '';
  // 复用主进程 port 实例（单一 native 逻辑源；addon 在闭包内 lazy 缓存）
  const nativePort = makeElectronComputerNativePort();

  const server = createServer((req, res) => {
    void (async () => {
      const body = await readJsonBody(req);
      const tokenHeader = req.headers[DEV_TOKEN_HEADER];
      const { status, body: respBody } = await routeLoopback(
        req.method,
        req.url,
        Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader,
        token,
        nativePort,
        body,
      );
      sendJson(res, status, respBody);
    })();
  });
  // 仅 127.0.0.1 bind（dev-only 权宜；不暴露到网络）
  server.listen(port, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`[computer-loopback] dev channel listening 127.0.0.1:${port}`);
  });
  return { close: () => server.close(), port };
}
