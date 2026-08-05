/**
 * HTTP 服务器适配层 — 用 node:http 启动 /counter API（运行时可移植）
 * 参考: specs/api/overall/01-counter.md §2.1（监听 127.0.0.1:API_PORT）
 *       本 task 指令（Bun.serve → node:http：bun 与 Node 主进程共用同一份代码）
 *
 * 设计：
 *   - 路由逻辑在 router.handleRequest（Web Request → Web Response 纯函数），**复用不变**
 *   - 本文件只做「node IncomingMessage/ServerResponse ↔ Web Request/Response」桥接：
 *       * node req.method/url/headers + body 流 → new Request()
 *       * Web Response.status/headers/body → node res.writeHead + 流写入
 *   - 统一注入 CORS 响应头（packaged 渲染层 file:// 跨域 fetch 必需）
 *   - OPTIONS 预检直接 204 + CORS 头（不进 router）
 *
 * 运行时：node:http 在 Node 与 Bun 均原生可用，故 dev（bun）/ packaged（Electron Node 主进程）共用。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { handleRequest } from './router';
import { startEventLoopMonitor } from './observability/event-loop-monitor';

/** CORS 响应头（packaged 渲染层跨域必需，dev 经 vite proxy 无需但保留无害） */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'Content-Type',
};

/** startServer 入参（依赖注入，便于测试与 Electron 复用） */
export interface StartServerOptions {
  /** 监听端口；0 = OS 分配（测试用），通常传 API_PORT */
  apiPort: number;
  /** ${DATA_DIR} 绝对路径，传给 counter store */
  dataDir: string;
  /** 监听 host，缺省 127.0.0.1（spec §2.1） */
  hostname?: string;
}

/** startServer 返回的句柄：暴露 actualPort + close */
export interface StartedServer {
  /** 实际监听端口（apiPort=0 时由 OS 分配） */
  port: number;
  /** 关闭服务器（已关则幂等） */
  close: () => void;
}

/**
 * 把 node IncomingMessage 转成 Web Request。
 * - url 补全成 `http://127.0.0.1<req.url>` 让 new URL() 能解析 pathname
 * - 透传 method、headers；body 用 stream 模式（node Web Readable 兼容 Request init.body）
 */
function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else headers.set(k, v);
  }
  // req.url 是 path+query（不含 host）；造一个合成 origin 让 URL 解析通过
  const url = `http://127.0.0.1${req.url ?? '/'}`;
  // body 流只对有 payload 的方法读取；GET/HEAD 传 null 避免挂起
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
    body: hasBody ? (req as unknown as ReadableStream) : null,
    // node req 是异步流；@types/node 提供 Readable → BodyInit 兼容，运行时 fetch 自己消费
    duplex: hasBody ? 'half' : undefined,
  });
}

/**
 * 把 Web Response 写入 node ServerResponse，附加 CORS 头。
 *
 * BUG-001 修复（[fixed] 2026-06-21）：不能用 `await web.arrayBuffer()` 缓冲整个 body。
 * 对 SSE（text/event-stream）长连接流，arrayBuffer() 会阻塞等流关闭才 resolve，
 * 而 SseChannel.openConnection() 的 ReadableStream 是无限循环（仅在连接断开时 done），
 * 导致帧从不刷给客户端（GET /sse 收 0 字节）。
 *
 * 修复：**流式 pump** —— 先 writeHead（status+headers），再用 reader 循环按块刷出，
 * 不缓冲。对普通 JSON 一次性读完也正确；对流式按 chunk 即时 flush。
 * 注意：SSE 不应设 content-length（让 node 自动 chunked），透传原 headers 即可。
 *
 * 导出（export）供 http-server-bridge-sse 集成测试直接验证 pump 行为（防回归）。
 */
export async function writeWebResponse(res: ServerResponse, web: Response): Promise<void> {
  const headers: Record<string, string> = { ...CORS_HEADERS };
  web.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  res.writeHead(web.status, headers);
  if (web.status === 204 || web.body == null) {
    res.end();
    return;
  }
  // 流式 pump：按 chunk 读取并即时 res.write（不缓冲）；
  // res.write 返 false 表示内部缓冲已满，等 'drain' 事件再继续（背压处理）
  const reader = web.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value == null) continue;
      // res.write 接收 Uint8Array；返回 false 时背压，等 drain
      if (!res.write(value)) {
        await new Promise<void>((r) => res.once('drain', () => r()));
      }
    }
  } finally {
    // 释放 reader 锁（即使中途异常也保证不泄漏）
    reader.releaseLock();
    res.end();
  }
}

/**
 * 启动 HTTP 服务器。返回 StartedServer 句柄（port + close）。
 * @param opts.apiPort 监听端口（0 = OS 分配）
 * @param opts.dataDir 数据目录绝对路径
 */
export function startServer(opts: StartServerOptions): Promise<StartedServer> {
  const hostname = opts.hostname ?? '127.0.0.1';
  const server: Server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        // OPTIONS 预检直接 204 + CORS（不进路由）
        if (req.method === 'OPTIONS') {
          res.writeHead(204, CORS_HEADERS);
          res.end();
          return;
        }
        const webReq = toWebRequest(req);
        const webRes = await handleRequest(webReq, opts.dataDir);
        await writeWebResponse(res, webRes);
      } catch (e) {
        // 兜底：未捕获异常返回 500 + CORS（避免 socket 挂起）
        // eslint-disable-next-line no-console
        console.error('[server] request error:', e);
        res.writeHead(500, { 'content-type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    },
  );
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.apiPort, hostname, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.apiPort;
      // 事件循环卡顿监控（默认关，EVENT_LOOP_MONITOR=1 开；Bun 不支持 monitorEventLoopDelay 时静默降级）。
      //   接线在 startServer 而非 bootstrapBuiltinPlugins：bootstrap 首请求才懒加载，覆盖不到启动期卡顿；
      //   startServer 是 dev(bun)/packaged(Electron Node) 共同的真实启动点。
      //   profile 目录 = <dataDir>/profiles/（dataDir 上游已经 resolveDataDir 展开为绝对路径）。
      const eventLoopMonitor = startEventLoopMonitor({
        source: 'server',
        profileDir: join(opts.dataDir, 'profiles'),
      });
      // eslint-disable-next-line no-console
      console.log(`[server] listening http://${hostname}:${port} dataDir=${opts.dataDir}`);
      resolve({
        port,
        close: () => {
          eventLoopMonitor.stop();
          server.close();
        },
      });
    });
  });
}
