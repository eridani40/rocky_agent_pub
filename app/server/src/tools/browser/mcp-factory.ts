/**
 * 默认 McpFactory 实现：运行时动态 require @modelcontextprotocol/sdk
 * 参考: specs/research/v0.0.23-browser-use.md §4.1（StdioClientTransport + Client.connect + listTools）
 *
 * 不把 SDK 编进 hard dep（保留为运行时 require），SDK 未安装时抛清晰错误提示安装。
 * UT 不用此实现（注入 mock factory）；真实 attach 路径由 ConnectorManager 用此工厂。
 */
import type { McpClient, McpFactory, StdioTransportOptions, StderrSink } from './mcp-types';

/** SDK 缺失错误信息 */
const SDK_MISSING_MSG =
  '@modelcontextprotocol/sdk 未安装；browser attach 需要 `bun add @modelcontextprotocol/sdk`';

/**
 * 动态加载 @modelcontextprotocol/sdk（Node CommonJS require）。
 * 返回 Client 构造器与 StdioClientTransport 构造器。
 *
 * BUG-002 修复：SDK v1.29.0 的 package.json main=None，bun 不解析 "." export 的
 * require 条件，裸包名 `require('@modelcontextprotocol/sdk')` 永远抛错，导致 connector
 * attach 时被 catch 误判为"SDK 未安装"。改为分别从两个子路径 require：
 *   - `@modelcontextprotocol/sdk/client` → 导出 Client
 *   - `@modelcontextprotocol/sdk/client/stdio.js` → 导出 StdioClientTransport（必须带 .js）
 */
function loadSdk(): {
  Client: new (info: { name: string; version: string }, opts: unknown) => unknown;
  StdioClientTransport: new (opts: unknown) => unknown;
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const clientMod = require('@modelcontextprotocol/sdk/client');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stdioMod = require('@modelcontextprotocol/sdk/client/stdio.js');
    if (!clientMod?.Client || !stdioMod?.StdioClientTransport) {
      throw new Error('SDK 模块导出缺失 Client 或 StdioClientTransport');
    }
    return {
      Client: clientMod.Client,
      StdioClientTransport: stdioMod.StdioClientTransport,
    };
  } catch (e) {
    // 兜底：保留原 SDK 缺失提示（子路径 require 失败时复用原消息）
    if (e instanceof Error && e.message === 'SDK 模块导出缺失 Client 或 StdioClientTransport') {
      throw e;
    }
    throw new Error(SDK_MISSING_MSG);
  }
}

/**
 * 默认 McpFactory：require SDK → new Client + StdioClientTransport。
 * stderr pipe 模式下监听 transport 的 stderr 事件收集 diagnostics。
 */
export const defaultMcpFactory: McpFactory = {
  create(opts: StdioTransportOptions, onStderr?: StderrSink) {
    const sdk = loadSdk();
    // stderr pipe：注入自定义 transport 把 stderr 转发到 sink
    const transport = createStdioTransport(sdk.StdioClientTransport, opts, onStderr);
    const client = new sdk.Client(
      { name: 'rocky-agent-browser', version: '0.0.0' },
      { capabilities: {} },
    );
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: wrapClient(client as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transport: wrapTransport(transport as any),
    };
  },

  async connect(client, transport, timeoutMs = 30_000): Promise<void> {
    // 带超时的 connect（race），SDK 缺失时 connect 早已在上一步抛错
    const raw = (transport as WrappedTransport).raw;
    await withTimeout(
      (client as WrappedClient).connectInternal(raw),
      timeoutMs,
      'chrome-devtools-mcp handshake 超时',
    );
  },
};

/** 包裹后的 transport（含原始 SDK transport） */
interface WrappedTransport {
  raw: unknown;
  close(): Promise<void>;
}

/** 包裹 SDK Client，暴露统一调用面 */
interface WrappedClient {
  connectInternal(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(req: unknown): Promise<unknown>;
  close(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapClient(raw: any): McpClient & WrappedClient {
  return {
    connectInternal: (transport) => raw.connect(transport),
    listTools: async () => {
      const r = await raw.listTools();
      return { tools: (r.tools ?? []).map((t: { name: string }) => ({ name: t.name })) };
    },
    callTool: async (req) => raw.callTool(req),
    close: async () => raw.close?.(),
  };
}

/** 包裹 transport，暴露统一 close */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapTransport(raw: any) {
  return {
    close: async () => raw.close?.(),
    // SDK 内部需要原始 transport 对象
    raw,
  };
}

/** 构造 StdioClientTransport；stderr pipe 时劫持 child.stderr 收集 diagnostics */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createStdioTransport(Ctor: any, opts: StdioTransportOptions, onStderr?: StderrSink): any {
  const t = new Ctor({
    command: opts.command,
    args: opts.args,
    stderr: opts.stderr ?? 'pipe',
    // env 仅在有值时传（packaged Electron 注入 ELECTRON_RUN_AS_NODE=1）；
    // 不传时 SDK 用默认环境，dev 行为不回归
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (onStderr && opts.stderr !== 'inherit') {
    // SDK transport 启动 child 后暴露 _process.stderr；延迟监听（start 时才有）
    try {
      const child = t._process ?? t.stderr;
      if (child && typeof child.on === 'function') {
        child.on('data', (d: Buffer) => onStderr(d.toString('utf8')));
      } else {
        t.onerror = (e: unknown) => onStderr(String(e));
      }
    } catch {
      /* 监听失败不阻断连接 */
    }
  }
  return t;
}

/** Promise race 超时（handshake ~30s） */
async function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${msg} (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
