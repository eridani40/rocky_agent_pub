/**
 * ChromeMcpDriver —— BrowserDriver 实现（mode ③ attach 已开 chrome）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §4/§4.1（attach 默认 --autoConnect + 判据真实化 + MCP tool 映射）
 *       specs/research/v0.0.34-attach-connect.md（chrome-devtools-mcp 1.4.0 connect vs launch 根因）
 *
 * 机制：`resolveChromeMcpLaunch()` 优先用 `node <pkg bin 绝对路径>` 直连本地 chrome-devtools-mcp
 *   （避免 `npx -y chrome-devtools-mcp@latest` 每次冷下载 18M + 查 registry，慢网络/首次 > 30s
 *   handshake 超时；bundle 包 pin 版本，resolve 失败兜底 npx @<已装 version>），
 *   packaged Electron 下改用 process.execPath+ELECTRON_RUN_AS_NODE=1（PATH 无 node，同 node-worker-driver.defaultSpawn），
 *   + flags（attach 恒走 --autoConnect（chrome 144+ inspect 远调模式唯一可用）/
 *   --experimentalStructuredContent --experimental-page-id-routing / --userDataDir 透传），经 McpFactory（默认
 *   require @modelcontextprotocol/sdk）建 StdioClientTransport + Client，handshake 后 listTools 校验含
 *   list_pages（快速失败）+ 真跑一次 list_pages round-trip 确认已 attach 上目标 chrome（判据真实化），
 *   否则抛 attach_failed（错误消息先探测本机 Chrome 版本做差异化引导：<144 → 升级提示）。
 *
 * BrowserSession 实现 = MCP tool 映射（对齐 chrome-devtools-mcp 1.4.0
 *   + openclaw callTool 站点）：listPages→list_pages、selectPage→select_page、
 *   navigate→navigate_page{type:'url',url,pageId}、snapshot→take_snapshot{pageId}、
 *   click→click{uid,pageId}、type→fill{uid,value,pageId}、evaluate→evaluate_script{function,pageId}。
 *   **ref = uid**（snapshot 节点 id 字段）；**所有 page-scoped 工具强制 pageId(number)**，
 *   由 activePageId 跟踪（listPages 取 selected 页 / selectPage 显式设）。snapshot 解析抽到
 *   chrome-mcp-snapshot.ts。
 *
 * close 语义：attach 模式只清 emulation / detach，**不杀用户 chrome**（封装在 close 内）。
 * session 缓存 key=[profileName,userDataDir]，复用同 profile 的 MCP 连接。
 *
 * 注意：attach 模式由 ConnectorManager 统一持有 session（browser tool 只复用、不 connect/close）。
 *   本 driver.connect 主要供 ConnectorManager 在「toggle on → connected」流程调用。
 */
import type {
  BrowserDriver,
  BrowserSession,
  BrowserConnectOptions,
} from './types';
import { BrowserError } from './types';
import type {
  McpFactory,
  McpClient,
  McpTransport,
} from './mcp-types';
// ChromeMcpSession + extractPages/parsePageIdNumber 在 chrome-mcp-session.ts
export { extractPages, parsePageIdNumber } from './chrome-mcp-session';
import { ChromeMcpSession } from './chrome-mcp-session';
// attach 失败版本差异化引导（A14/A15：探测本机 Chrome 版本 → <144 升级提示 / ≥144 或失败 → 现有引导）
import { detectChromeVersion } from './chrome-version';
// v0.0.337 H1：进程回收依赖（对齐 336 AttachKillDeps 形态，UT mock 不真杀进程）
import { isPidAlive, killProcessGroupByPid } from './instance-record';
import { execSync } from 'node:child_process';

/** chrome-devtools-mcp 必备 tool（handshake 校验 + 判据真实化 round-trip 探测） */
const REQUIRED_MCP_TOOL = 'list_pages';

/** chrome 连接失败错误正则（参考 openclaw CHROME_CONNECTION_TOOL_ERROR_RE） */
const ATTACH_FAIL_RE =
  /Could not connect|DevToolsActivePort|ECONNREFUSED|Failed to connect/i;

/** handshake 默认超时（参考调研 §4 handshake ~30s） */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** 进程回收依赖（v0.0.337 H1：对齐 336 AttachKillDeps 形态；缺省真实实现） */
export interface ChromeKillDeps {
  /** pid 存活检查（缺省 instance-record.isPidAlive） */
  isPidAlive?: (pid: number) => boolean;
  /** 杀进程组（缺省 instance-record.killProcessGroupByPid） */
  killProcessGroup?: (pid: number) => void;
  /** pkill 命令执行（缺省 child_process.execSync；UT 注入 spy 断言 --parent-pid 锚定） */
  execPkill?: (cmd: string) => void;
}

/** ChromeMcpDriver 工厂参数 */
export interface ChromeMcpDriverOptions {
  /** MCP factory（依赖注入；默认运行时 require SDK） */
  mcpFactory: McpFactory;
  /** 本机 Chrome 版本探测（依赖注入；UT mock 不真跑 chrome --version；缺省生产实现 detectChromeVersion） */
  detectVersion?: () => Promise<number | undefined>;
  /** 进程回收依赖（v0.0.337 H1：connect 失败清理 kill 进程组 + watchdog；UT mock） */
  killDeps?: ChromeKillDeps;
}

/** session 缓存 key（BrowserConnectOptions 子集；attach 仅 autoConnect → [profileName, userDataDir] 二元组） */
interface SessionCacheKey {
  profileName?: string;
  userDataDir?: string;
}

interface CachedSession {
  session: BrowserSession;
  client: McpClient;
  transport: McpTransport;
  /** MCP 子进程 pid（v0.0.334 B7：attach 台账锚点，孤儿 MCP 代理回收用；拿不到 undefined） */
  pid?: number;
}

/**
 * ChromeMcpDriver（mode ③ attach）。
 * 单实例跨多次 connect 复用同 profile 的 MCP 连接（ConnectorManager 持有一个 driver 实例）。
 */
export class ChromeMcpDriver implements BrowserDriver {
  readonly mode = 'attach' as const;
  private readonly mcpFactory: McpFactory;
  private readonly detectVersion: () => Promise<number | undefined>;
  /** 进程回收依赖（v0.0.337 H1：connect 失败清理 kill 组 + watchdog；缺省真实实现） */
  private readonly killDeps: Required<ChromeKillDeps>;
  /** session 缓存（key 序列化 JSON） */
  private readonly cache = new Map<string, CachedSession>();
  /** 最近一次 connect 成功的 MCP 子进程 pid（v0.0.334 B7：attach 台账锚点；disconnect 清） */
  private lastMcpPid: number | undefined;
  /** 最近一次 spawn 的 MCP 子进程 pid（v0.0.337 H5：spawn 即记含失败，失败也可读；disconnect 清） */
  private lastSpawnPid: number | undefined;

  constructor(opts: ChromeMcpDriverOptions) {
    this.mcpFactory = opts.mcpFactory;
    this.detectVersion = opts.detectVersion ?? (() => detectChromeVersion());
    // H1：缺省真实实现（instance-record + execSync stdio ignore）；UT 注入 spy 断言
    this.killDeps = {
      isPidAlive: opts.killDeps?.isPidAlive ?? isPidAlive,
      killProcessGroup: opts.killDeps?.killProcessGroup ?? killProcessGroupByPid,
      execPkill: opts.killDeps?.execPkill ?? ((cmd) => { execSync(cmd, { stdio: 'ignore' }); }),
    };
  }

  async connect(opts: BrowserConnectOptions, signal?: AbortSignal): Promise<BrowserSession> {
    const key = this.cacheKey(opts);
    const hit = this.cache.get(key);
    if (hit) return hit.session;

    // node 直连本地 bin（resolve 失败兜底 npx），避免 npx 冷下载 + registry 查询
    const launch = resolveChromeMcpLaunch();
    const flags = buildChromeMcpArgs({
      profileName: opts.profileName,
      userDataDir: opts.userDataDir,
    });
    const args = [...launch.baseArgs, ...flags];
    const diagnostics: string[] = [];
    const { client, transport } = this.mcpFactory.create(
      { command: launch.command, args, stderr: 'pipe', env: launch.env },
      (chunk) => diagnostics.push(chunk),
    );
    // v0.0.337 H5：spawn 即记（成功失败都记，失败也可读——供 H9 失败入台账兜底）
    this.lastSpawnPid = transport.pid;

    try {
      // v0.0.337 H3：signal 感知（abort → 抛 attach_failed → 走 catch → H2 清理）
      await this.withAbort(
        this.mcpFactory.connect(client, transport, HANDSHAKE_TIMEOUT_MS),
        signal,
        'attach 连接中止（launch 超时）',
      );
      // 判据①（快速失败）：listTools 含 list_pages —— 进程没起/工具缺失早退，省一次 callTool
      const tools = await this.withAbort(client.listTools(), signal, 'attach 工具探测中止');
      if (!tools.tools.some((t) => t.name === REQUIRED_MCP_TOOL)) {
        throw new BrowserError(
          'attach_failed',
          `chrome-devtools-mcp 未暴露 ${REQUIRED_MCP_TOOL}（连接对象非 chrome?）`,
        );
      }
      // 判据②（真实性确认）：真跑一次 list_pages round-trip。
      //   chrome-devtools-mcp 惰性连接（handshake/listTools 不碰 chrome），仅靠它们无法确认 attach；
      //   唯有真调一次 page 工具才能探到「是否 attach 上目标 chrome」。连不上时返回
      //   {isError:true, content:[{text:'Could not connect to Chrome...'}]} 而**不抛**——
      //   必须查 probe.isError（不能只靠 try/catch）；callTool 自身 reject 则落本 try 的 catch 兜底。
      const probe = await this.withAbort(
        client.callTool({ name: REQUIRED_MCP_TOOL, arguments: {} }),
        signal,
        'attach 校验中止',
      );
      if (probe.isError) {
        const txt = probe.content?.[0]?.text ?? '未知错误';
        throw new BrowserError(
          'attach_failed',
          await this.attachFailGuide(`attach 校验失败（未连上目标 chrome）: ${txt}`),
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 失败清理①：graceful client.close 先于 kill transport.close（对齐 disconnect，不留 orphan）
      await closeMcpClientThenTransport(client, transport);
      // 失败清理②（v0.0.337 H2）：kill mcp 主进程组 + watchdog。
      //   transport.close 只杀 mcp 主进程本身；进程组内子进程 + detached watchdog（独立进程组）
      //   需 killProcessGroupByPid + --parent-pid 精确 pkill 兜底（对齐 336 close 三层清理）。
      const pid = transport.pid;
      if (pid !== undefined) {
        try {
          if (this.killDeps.isPidAlive(pid)) this.killDeps.killProcessGroup(pid);
        } catch {
          /* best-effort：kill 失败不阻断 attach_failed 上报 */
        }
        this.killOrphanMcpWatchdog(pid);
      }
      if (ATTACH_FAIL_RE.test(msg) || e instanceof BrowserError) {
        throw new BrowserError(
          'attach_failed',
          await this.attachFailGuide(`browser attach 连接失败: ${msg}${diagnostics.length ? ` (stderr: ${diagnostics.join('').slice(-200)})` : ''}`),
        );
      }
      throw new BrowserError('attach_failed', `browser attach 异常: ${msg}`);
    }

    const session = new ChromeMcpSession(client);
    const pid = transport.pid; // MCP 子进程 pid（B7：attach 台账锚点；拿不到 undefined）
    this.cache.set(key, { session, client, transport, pid });
    if (pid !== undefined) this.lastMcpPid = pid;
    return session;
  }

  /**
   * v0.0.337 H3：abort 感知包装。signal 触发 abort → reject BrowserError('attach_failed')（走 connect catch → H2 清理）；
   * 底层流程的最终 settle 由 then 回调吞掉（已 settled 后 no-op），不留 unhandled rejection。
   * signal 缺省 undefined → 原样返回（行为零变化）。
   */
  private async withAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, msg: string): Promise<T> {
    if (!signal) return p;
    if (signal.aborted) throw new BrowserError('attach_failed', msg);
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener('abort', onAbort);
      const onAbort = (): void => {
        cleanup();
        reject(new BrowserError('attach_failed', msg));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => { cleanup(); resolve(v); },
        (e) => { cleanup(); reject(e); },
      );
    });
  }

  /**
   * v0.0.337 H5：最近一次 spawn 的 MCP 子进程 pid（含失败；spawn 即记，disconnect 清）。
   * 与 lastMcpPid（仅 connect 成功 set）区分：失败路径也可读——H9 失败入台账兜底锚点。
   * @internal attach 台账用
   */
  getLastSpawnPid(): number | undefined {
    return this.lastSpawnPid;
  }

  /**
   * 杀 detached watchdog（chrome-devtools-mcp --parent-pid=<mcpPid> 精确锚定，win32 跳过）。
   * v0.0.337 H2：connect 失败清理最后一步（逻辑与 336 G5 一致）；best-effort（失败不阻断）。
   */
  private killOrphanMcpWatchdog(mcpPid: number): void {
    if (process.platform === 'win32') return;
    try {
      this.killDeps.execPkill(`pkill -9 -f "chrome-devtools-mcp.*--parent-pid=${mcpPid}"`);
    } catch {
      /* best-effort */
    }
  }

  /**
   * 最近一次 connect 成功的 MCP 子进程 pid（v0.0.334 B7）。
   * attach-instance 经 connectAttachSession 结果取；disconnect 后清 undefined。
   * @internal attach 台账用（孤儿 MCP 代理回收锚点）
   */
  getLastMcpPid(): number | undefined {
    return this.lastMcpPid;
  }

  /**
   * 断开某 profile 的 attach session（ConnectorManager toggle off / browser tool disconnect 调用）。
   *
   * graceful client.close() 对齐 openclaw closeChromeMcpClientAndProcess
   * 语义——graceful 先于 kill：
   *   1. session.close()：no-op（attach 不杀用户 chrome），满足协议占位。
   *   2. client.close()（graceful）：触发 chrome-devtools-mcp closeBrowser → puppeteer.disconnect
   *      → 主动释放 16 个 CDP attach（缺此步会 WS 残留）。
   *   3. transport.close()（kill 兜底）：stdin.end + SIGTERM，Bun 下 ~3s 内杀进程。
   *
   * SDK 细节：@modelcontextprotocol/sdk Client.close() 内部会调 transport.close()，
   * 故步骤 2 可能已关 transport、步骤 3 重复关会抛错 → 三步各自独立 try/catch 吞掉，
   * 任一失败不阻断后续（这正是「graceful 失败不阻断 kill 兜底」的语义）。
   *
   * attach 不杀用户 chrome（杀的是 chrome-devtools-mcp 子进程，它到 chrome 的 WS 随之释放）。
   * 幂等：cache miss 时 no-op（同 opts 再调一次直接 return）。
   */
  async disconnect(opts: BrowserConnectOptions): Promise<void> {
    const key = this.cacheKey(opts);
    const hit = this.cache.get(key);
    if (!hit) return;
    this.cache.delete(key);
    if (this.lastMcpPid === hit.pid) this.lastMcpPid = undefined; // 断连清锚点（防残留 pid 误用）
    if (this.lastSpawnPid === hit.pid) this.lastSpawnPid = undefined; // H5：spawn 锚点同步清

    // 步骤 1：session.close()（no-op 占位）
    try {
      await hit.session.close();
    } catch {
      /* ignore：session.close 失败不阻断 client/transport 释放 */
    }
    // 步骤 2+3：graceful client.close → kill transport.close（兜底），见 closeMcpClientThenTransport
    await closeMcpClientThenTransport(hit.client, hit.transport);
  }

  private cacheKey(opts: SessionCacheKey): string {
    return JSON.stringify([
      opts.profileName ?? null,
      opts.userDataDir ?? null,
    ]);
  }

  /**
   * attach 失败引导文本（A15：版本差异化，单处权威不双拼）。
   * 先探测本机 Chrome 版本：
   *   - 版本存在且 <144 → 「检测到 Chrome v<v>（<144），attach 需 Chrome ≥144（chrome://inspect 远调模式），请升级 Chrome 后重试」；
   *   - ≥144 或探测失败 → 现有引导（开启/批准 remote debugging，含 chrome://inspect 路径 + ≥144 + 同意 prompt）。
   * 版本探测失败不改变错误 kind（仍 attach_failed），不阻断主流程。
   */
  private async attachFailGuide(prefix: string): Promise<string> {
    let version: number | undefined;
    try {
      version = await this.detectVersion();
    } catch {
      version = undefined; // 版本探测异常 → 走现有引导（A15：探测失败不改变 kind，不阻断）
    }
    if (version !== undefined && version < 144) {
      return `${prefix}。检测到 Chrome v${version}（<144），attach 需 Chrome ≥144（chrome://inspect 远调模式），请升级 Chrome 后重试`;
    }
    return `${prefix}。请确认用户 Chrome 已开启 remote debugging（chrome://inspect/#remote-debugging → Enable remote debugging，Chrome ≥144）并批准连接同意 prompt；连不上时提示用户去开启/批准后重试`;
  }
}

/**
 * graceful client.close()（释放 CDP attach / 触发 closeBrowser）先于 transport.close()（kill MCP 进程兜底）。
 * connect 失败清理与 disconnect 复用此序列：两步各自独立 try/catch 吞错——SDK
 * Client.close 内部会关 transport（步骤 2 已关致步骤 3 重复关抛错），handshake 失败时 client.close
 * 本身亦可能 throw；任一失败都不阻断后续，确保不留 orphan chrome-devtools-mcp 进程。
 */
async function closeMcpClientThenTransport(
  client: McpClient,
  transport: McpTransport,
): Promise<void> {
  try {
    await client.close();
  } catch {
    /* ignore：graceful 失败不阻断 kill 兜底 */
  }
  try {
    await transport.close();
  } catch {
    /* ignore */
  }
}

/** 是否 attach 连接错误（供 ConnectorManager 错误归类） */
export function isAttachConnectError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return ATTACH_FAIL_RE.test(msg);
}

/**
 * 构建 chrome-devtools-mcp spawn **flags**（不含 command、不含 -y/包名前缀）。
 *
 * connection flag：恒 `--autoConnect`（chrome 144+ chrome://inspect 远调模式唯一可用——
 * 该模式不暴露 /json/version（返 404 是正常的，见 memory browser-attach-debug-run-directly），
 * --browserUrl/--wsEndpoint 在该模式下必失败；无 URL 输入，autoConnect 自动连用户已开 Chrome）。
 * autoConnect "自启空 chrome" 的副作用 → 由 connect() 的 list_pages probe 在 isError 层兜住。
 *
 * command + 包名前缀由 `resolveChromeMcpLaunch()` 返回（node 直连本地 bin / npx 兜底），此处只关心 flag。
 * @internal 导出仅供 UT
 */
export function buildChromeMcpArgs(input: {
  profileName?: string;
  userDataDir?: string;
}): string[] {
  const args: string[] = [];
  args.push('--autoConnect');
  args.push('--experimentalStructuredContent', '--experimental-page-id-routing');
  if (input.userDataDir) args.push('--userDataDir', input.userDataDir);
  return args;
}

/**
 * 解析 chrome-devtools-mcp 启动命令。
 *
 * 主路径：`require.resolve('chrome-devtools-mcp/package.json')` 拿包目录 → 读
 *   `bin['chrome-devtools-mcp']` → 拼 `<pkgDir>/<bin>` 绝对路径。
 *   chrome-devtools-mcp `"type":"module"`、bin 是 ESM .js；`node <bin.js>` 直接跑（不加实验 flag）。
 * packaged Electron 适配：主进程内 PATH 无 node，字面 'node' 必崩 ENOENT——仅当
 *   `process.versions.electron` 为真改用 `process.execPath` + `env.ELECTRON_RUN_AS_NODE=1`
 *   （纯 node 语义，同 node-worker-driver.defaultSpawn；memory packaged-spawn-external-binary-exec-path），
 *   dev/bun 保持 'node' 不变。
 * 兜底（resolve 失败 / bin 缺失）：`{ command: 'npx', baseArgs: ['-y','chrome-devtools-mcp'] }`
 *   （resolve 失败=包不可见，读 version 必同样失败是死代码，让 npx 自取 latest；packaged 下 npx 不可用保持现状）。
 * @internal 导出仅供 UT
 */
export function resolveChromeMcpLaunch(): { command: string; baseArgs: string[]; env?: Record<string, string> } {
  try {
    const pkgPath = require.resolve('chrome-devtools-mcp/package.json');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(pkgPath) as {
      bin?: Record<string, string> | string;
    };
    const binField = pkg.bin;
    const binRel =
      typeof binField === 'string' ? binField : (binField?.['chrome-devtools-mcp'] ?? undefined);
    if (!binRel) throw new Error('chrome-devtools-mcp package.json 缺 bin[chrome-devtools-mcp]');
    const path = require('path');
    const binAbs = path.resolve(path.dirname(pkgPath), binRel);
    if (process.versions.electron) {
      return { command: process.execPath, baseArgs: [binAbs], env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
    return { command: 'node', baseArgs: [binAbs] };
  } catch {
    return { command: 'npx', baseArgs: ['-y', 'chrome-devtools-mcp'] };
  }
}
