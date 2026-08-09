/**
 * MCP client/transport 最小抽象层（chrome-devtools-mcp attach 用）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §4（ChromeMcpDriver）
 *       specs/research/v0.0.23-browser-use.md §4.1（StdioClientTransport + Client.listTools）
 *
 * 设计：不把 @modelcontextprotocol/sdk 编进 hard dep（保留为运行时动态 require），
 * 而是抽象出最小调用面（McpClient / McpTransport / McpFactory），便于：
 *   1. UT 注入 mock（不 spawn 真 npx，不连真 chrome）
 *   2. 真实实现（defaultMcpFactory）按需 require SDK，未安装时抛清晰错误
 *
 * 调用面只覆盖 browser tool 需要的 4 个 MCP tool：list_pages / select_page /
 * navigate_page / snapshot / click / type / evaluate_script。
 */

/** MCP tool 调用入参 */
export interface McpCallToolRequest {
  /** MCP tool 名（如 list_pages / navigate_page） */
  name: string;
  /** MCP tool 入参 */
  arguments?: Record<string, unknown>;
}

/** MCP tool 调用返回（content 数组 + 可选结构化内容；详见 MCP 协议） */
export interface McpCallToolResult {
  /** 是否出错（MCP is_error） */
  isError?: boolean;
  /** content blocks（text/image/...） */
  content?: Array<{ type: string; text?: string }>;
  /** 结构化内容（chrome-devtools-mcp --experimentalStructuredContent 启用后给结构化 page 列表） */
  structuredContent?: unknown;
}

/** MCP client 调用面（仅暴露 listTools / callTool / close） */
export interface McpClient {
  /** 列出 server 提供的 tools（attach handshake 后校验含 list_pages） */
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  /** 调用单个 MCP tool */
  callTool(req: McpCallToolRequest): Promise<McpCallToolResult>;
  /** 关闭 client（关 transport） */
  close(): Promise<void>;
}

/** Stdio transport 构造参数（与 @modelcontextprotocol/sdk StdioClientTransport 对齐） */
export interface StdioTransportOptions {
  command: string;
  args: string[];
  stderr?: 'pipe' | 'inherit';
  /**
   * 子进程环境变量（可选）。packaged Electron 下注入 ELECTRON_RUN_AS_NODE=1
   * （配合 command=process.execPath，让 Electron binary 以纯 node 语义跑 MCP server）；
   * SDK 内部会把它与 getDefaultEnvironment() merge。不传时行为与之前完全一致。
   */
  env?: Record<string, string>;
}

/** transport 句柄（只暴露 close；连接由 client.connect 完成） */
export interface McpTransport {
  close(): Promise<void>;
}

/** stderr 诊断收集器（pipe 模式由 factory 注入；attach_failed 归因用） */
export type StderrSink = (chunk: string) => void;

/**
 * MCP factory——产出 (client, transport) 对。ChromeMcpDriver 经依赖注入拿工厂实例。
 * defaultMcpFactory 运行时 require @modelcontextprotocol/sdk；UT 注入 mock factory。
 */
export interface McpFactory {
  /**
   * 创建 StdioClientTransport + Client（已 new，未 connect）。
   * @param opts stdio 构造参数
   * @param onStderr stderr pipe 收集回调（diagnostics）
   */
  create(
    opts: StdioTransportOptions,
    onStderr?: StderrSink,
  ): { client: McpClient; transport: McpTransport };
  /**
   * 连接 transport（client.connect(transport)），handshake timeout ~30s。
   * 连不上抛 Error（消息含 "Could not connect" / "ECONNREFUSED" 等，上层映射 attach_failed）。
   */
  connect(client: McpClient, transport: McpTransport, timeoutMs?: number): Promise<void>;
}
