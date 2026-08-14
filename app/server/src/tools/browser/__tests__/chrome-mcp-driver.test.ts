/**
 * ChromeMcpDriver 单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §4
 *       states/v0.0.23 verify test-plan（br_attach_tc1 semi-manual 由 verifier 跑）
 *
 * 覆盖（不 spawn 真 npx / 不连真 chrome）：
 *   - buildChromeMcpArgs：[v0.0.334] 恒 --autoConnect（删 browserUrl/wsEndpoint 分支）/ userDataDir 透传 / 必备 experimental flag
 *   - connect：handshake 成功后 listTools 校验含 list_pages；缺 → attach_failed
 *   - connect：[v0.0.34] 判据真实化——list_pages probe isError:true / callTool reject → attach_failed；probe 成功（isError falsy）→ connected
 *   - connect：[v0.0.334] 错误消息版本差异化引导（mock detectChromeVersion：<144 → 请升级 Chrome；≥144/探测失败 → 现有引导）
 *   - connect：handshake 失败（ECONNREFUSED）→ BrowserError attach_failed
 *   - session 缓存：同 profile connect 复用、不同 profile 新连；key=[profileName, userDataDir] 二元组
 *   - MCP tool 映射：listPages/selectPage/navigate/snapshot/click/type/evaluate → 对应 MCP tool
 *     （注：[v0.0.34] connect 时 probe 多调一次 list_pages，session 断言前需 callToolCalls.length=0 重置）
 *   - close：只清 emulation 不杀用户 chrome（no-op，不抛）
 *   - disconnect：清缓存 + close transport
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChromeMcpDriver,
  buildChromeMcpArgs,
  resolveChromeMcpLaunch,
  isAttachConnectError,
  extractPages,
  parsePageIdNumber,
} from '../chrome-mcp-driver';
import { parseChromeMcpSnapshot } from '../chrome-mcp-snapshot';
import { BrowserError } from '../types';
import type {
  McpFactory,
  McpClient,
  McpTransport,
  McpCallToolResult,
} from '../mcp-types';

/** mock detectVersion：UT 不真跑 chrome --version（DI 注入 ChromeMcpDriverOptions.detectVersion） */
const detectVersion = vi.fn(async (): Promise<number | undefined> => undefined);

beforeEach(() => {
  detectVersion.mockReset();
  detectVersion.mockResolvedValue(undefined);
});

// ---- mock McpFactory：记录 create 入参（含 args/env）+ 可控行为 ----
interface MockState {
  createCalls: { command: string; args: string[]; env?: Record<string, string> }[];
  listToolsNames: string[];
  connectShouldFail?: Error;
  callToolCalls: { name: string; arguments?: Record<string, unknown> }[];
  callToolResult: McpCallToolResult;
  /** [v0.0.334 B7] mock transport 携带的 MCP 子进程 pid（attach 台账锚点） */
  transportPid?: number;
}

function makeMockFactory(state: MockState): McpFactory {
  return {
    create(opts) {
      state.createCalls.push({ command: opts.command, args: opts.args, env: opts.env });
      const client: McpClient = {
        listTools: async () => ({ tools: state.listToolsNames.map((n) => ({ name: n })) }),
        callTool: async (req) => {
          state.callToolCalls.push({ name: req.name, arguments: req.arguments });
          return state.callToolResult;
        },
        close: async () => {},
      };
      const transport: McpTransport = {
        close: async () => {},
        ...(state.transportPid !== undefined ? { pid: state.transportPid } : {}),
      };
      return { client, transport };
    },
    async connect(_client, _transport) {
      if (state.connectShouldFail) throw state.connectShouldFail;
    },
  };
}

describe('buildChromeMcpArgs（v0.0.29 BUG-003：只返回 flags，不含 -y/包名前缀）', () => {
  it('[v0.0.334] 恒 --autoConnect（无 browserUrl/wsEndpoint 分支，chrome 144+ inspect 远调模式唯一可用）', () => {
    const args = buildChromeMcpArgs({ profileName: 'p1' });
    // v0.0.34 一度默认改为 --browserUrl loopback 试图禁止自启，但 chrome 144+ chrome://inspect 模式
    // 不暴露 /json/version (404)，--browserUrl 必失败 'Failed to fetch ... HTTP Not Found'。
    // 回退到 --autoConnect 默认；autoConnect "自启空 chrome" 副作用由 connect() probe isError 兜住。
    expect(args).toContain('--autoConnect');
    expect(args).not.toContain('--browserUrl');
    expect(args).not.toContain('--wsEndpoint');
    expect(args).toContain('--experimentalStructuredContent');
    expect(args).toContain('--experimental-page-id-routing');
    expect(args).not.toContain('-y');
    expect(args.some((a) => a.startsWith('chrome-devtools-mcp'))).toBe(false);
  });

  it('userDataDir 透传 --userDataDir', () => {
    const args = buildChromeMcpArgs({
      userDataDir: '/tmp/brave-profile',
    });
    expect(args).toContain('--autoConnect');
    expect(args).toContain('--userDataDir');
    expect(args).toContain('/tmp/brave-profile');
  });
});

describe('resolveChromeMcpLaunch（v0.0.29 BUG-003：node 直连本地 bin）', () => {
  it('主路径：返回 command=node + baseArgs=[bin 绝对路径]', () => {
    const launch = resolveChromeMcpLaunch();
    expect(launch.command).toBe('node');
    expect(launch.baseArgs).toHaveLength(1);
    const binPath = launch.baseArgs[0]!;
    // 绝对路径 + 指向 chrome-devtools-mcp.js bin
    expect(binPath.startsWith('/')).toBe(true);
    expect(binPath.endsWith('chrome-devtools-mcp.js')).toBe(true);
  });

  it('主路径：bin 路径真实存在（bundle 已装）', () => {
    const launch = resolveChromeMcpLaunch();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    expect(fs.existsSync(launch.baseArgs[0])).toBe(true);
  });

  it('返回结构契约：{command, baseArgs}，baseArgs 非空字符串数组', () => {
    // require.resolve 在测试环境（包已装）必成功，无法直接触发兜底分支；
    // 这里只验证返回结构契约正确（command 是 node/npx，baseArgs 非空字符串数组）。
    const launch = resolveChromeMcpLaunch();
    expect(['node', 'npx']).toContain(launch.command);
    expect(Array.isArray(launch.baseArgs)).toBe(true);
    expect(launch.baseArgs.length).toBeGreaterThanOrEqual(1);
    expect(launch.baseArgs.every((a) => typeof a === 'string')).toBe(true);
  });

  // packaged Electron 适配：mock process.versions.electron，afterEach 还原（防污染同文件其他用例）
  // （对齐 node-worker-driver.test.ts 的 defaultSpawn packaged 用例模式）
  let savedElectron: string | undefined;
  beforeEach(() => {
    savedElectron = process.versions.electron;
  });
  afterEach(() => {
    const versions = process.versions as { electron?: string };
    if (savedElectron === undefined) delete versions.electron;
    else versions.electron = savedElectron;
  });

  it('[packaged] process.versions.electron 有值 → command=process.execPath + env.ELECTRON_RUN_AS_NODE=1，baseArgs 仍本地 bin', () => {
    (process.versions as { electron?: string }).electron = '99.0.0';
    const launch = resolveChromeMcpLaunch();
    expect(launch.command).toBe(process.execPath);
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(launch.baseArgs).toHaveLength(1);
    expect(launch.baseArgs[0]!.endsWith('chrome-devtools-mcp.js')).toBe(true);
  });

  it('[dev 不回归] process.versions.electron undefined → command=node 且无 env', () => {
    delete (process.versions as { electron?: string }).electron;
    const launch = resolveChromeMcpLaunch();
    expect(launch.command).toBe('node');
    expect(launch.env).toBeUndefined();
  });

  it('[packaged] connect 把 launch.env 透传给 mcpFactory.create（ELECTRON_RUN_AS_NODE=1 到达 transport）', async () => {
    (process.versions as { electron?: string }).electron = '99.0.0';
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await driver.connect({ profileName: 'p-electron' });
    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0]!.command).toBe(process.execPath);
    expect(state.createCalls[0]!.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('[dev 不回归] connect 无 env 传给 mcpFactory.create（command=node）', async () => {
    delete (process.versions as { electron?: string }).electron;
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await driver.connect({ profileName: 'p-dev' });
    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0]!.command).toBe('node');
    expect(state.createCalls[0]!.env).toBeUndefined();
  });
});

describe('ChromeMcpDriver.connect：handshake', () => {
  it('[v0.0.34.1] listTools 含 list_pages + probe 成功（isError falsy）→ connected，args 含 --autoConnect', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages', 'navigate_page', 'snapshot'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    const session = await driver.connect({ profileName: 'p1' });
    expect(state.createCalls).toHaveLength(1);
    // v0.0.34.1 HOTFIX：默认回退 --autoConnect（chrome 144+ inspect 模式唯一可用）
    expect(state.createCalls[0]!.args).toContain('--autoConnect');
    expect(state.createCalls[0]!.args).not.toContain('--browserUrl');
    // 治理2 保留：connect 真跑一次 list_pages probe（判据真实化）
    expect(state.callToolCalls).toHaveLength(1);
    expect(state.callToolCalls[0]).toEqual({ name: 'list_pages', arguments: {} });
    expect(session).toBeDefined();
  });

  it('[v0.0.34] probe isError:true（未连上目标 chrome）→ attach_failed', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      // chrome-devtools-mcp 连不上时 list_pages 返 {isError:true,...}（不抛）
      callToolResult: {
        isError: true,
        content: [{ type: 'text', text: 'Could not connect to Chrome. Check if Chrome is running...' }],
      },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({
      kind: 'attach_failed',
    });
    // probe 确实被调（判据真实化）
    expect(state.callToolCalls).toEqual([{ name: 'list_pages', arguments: {} }]);
  });

  it('[v0.0.334 A15] probe isError + 本机 Chrome <144 → 消息含「请升级 Chrome」', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: {
        isError: true,
        content: [{ type: 'text', text: 'Could not connect to Chrome...' }],
      },
    };
    detectVersion.mockResolvedValueOnce(130);
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state), detectVersion });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({
      kind: 'attach_failed',
      message: expect.stringContaining('检测到 Chrome v130（<144）'),
    });
  });

  it('[v0.0.334 A15] probe isError + 本机 Chrome ≥144 → 现有引导（chrome://inspect + ≥144 + 同意 prompt）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: {
        isError: true,
        content: [{ type: 'text', text: 'Could not connect to Chrome...' }],
      },
    };
    detectVersion.mockResolvedValueOnce(144);
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state), detectVersion });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({
      kind: 'attach_failed',
      message: expect.stringContaining('chrome://inspect/#remote-debugging'),
    });
  });

  it('[v0.0.334 A15] probe isError + 版本探测失败（undefined）→ 现有引导不阻断（kind 仍 attach_failed）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: {
        isError: true,
        content: [{ type: 'text', text: 'Could not connect to Chrome...' }],
      },
    };
    detectVersion.mockResolvedValueOnce(undefined);
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state), detectVersion });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({
      kind: 'attach_failed',
      message: expect.stringContaining('chrome://inspect/#remote-debugging'),
    });
  });

  it('[v0.0.334 A15] catch 分支（handshake ECONNREFUSED）+ 本机 Chrome <144 → 消息含「请升级 Chrome」', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      connectShouldFail: new Error('Could not connect to Chrome: ECONNREFUSED 127.0.0.1:9222'),
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    detectVersion.mockResolvedValueOnce(100);
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state), detectVersion });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({
      kind: 'attach_failed',
      message: expect.stringContaining('检测到 Chrome v100（<144）'),
    });
  });

  it('[v0.0.34] probe callTool 自身 reject → attach_failed（catch 兜底）', async () => {
    const factory: McpFactory = {
      create() {
        const client: McpClient = {
          listTools: async () => ({ tools: [{ name: 'list_pages' }] }),
          // probe callTool reject（区别于 isError 返回）
          callTool: async () => {
            throw new Error('Could not connect to Chrome: ECONNREFUSED 127.0.0.1:9222');
          },
          close: async () => {},
        };
        const transport: McpTransport = { close: async () => {} };
        return { client, transport };
      },
      async connect() {},
    };
    const driver = new ChromeMcpDriver({ mcpFactory: factory });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({
      kind: 'attach_failed',
    });
  });

  it('[v0.0.34] probe 失败时清理：client.close + transport.close 都被调（不留 orphan）', async () => {
    const clientClose = vi.fn(async () => {});
    const transportClose = vi.fn(async () => {});
    const factory: McpFactory = {
      create() {
        const client: McpClient = {
          listTools: async () => ({ tools: [{ name: 'list_pages' }] }),
          callTool: async () => ({
            isError: true,
            content: [{ type: 'text', text: 'Could not connect to Chrome...' }],
          }),
          close: clientClose,
        };
        const transport: McpTransport = { close: transportClose };
        return { client, transport };
      },
      async connect() {},
    };
    const driver = new ChromeMcpDriver({ mcpFactory: factory });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({
      kind: 'attach_failed',
    });
    // 失败清理：graceful client.close 先于 kill transport.close
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(transportClose).toHaveBeenCalledTimes(1);
  });

  it('listTools 缺 list_pages → BrowserError attach_failed', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['navigate_page'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({
      kind: 'attach_failed',
    });
  });

  it('handshake ECONNREFUSED → attach_failed（含 stderr）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      connectShouldFail: new Error('Could not connect to Chrome: ECONNREFUSED 127.0.0.1:9222'),
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({
      kind: 'attach_failed',
    });
  });

  // ---- v0.0.337 H1/H2：connect 失败清理升级（kill 进程组 + watchdog，killDeps DI） ----
  it('[v0.0.337 H1/H2] probe isError → killProcessGroup(transport.pid) + execPkill(--parent-pid=<pid>) 被调（失败清理顺序：graceful close → kill 组 → watchdog）', async () => {
    const killProcessGroupSpy = vi.fn((_pid: number) => {});
    const execPkillSpy = vi.fn((_cmd: string) => {});
    const killDeps = {
      isPidAlive: vi.fn(() => true),
      killProcessGroup: killProcessGroupSpy,
      execPkill: execPkillSpy,
    };
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: {
        isError: true,
        content: [{ type: 'text', text: 'Could not connect to Chrome...' }],
      },
      transportPid: 4242,
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state), killDeps });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({ kind: 'attach_failed' });
    // H2 ①：kill mcp 主进程组（pid 存活时，SIGKILL）
    expect(killDeps.isPidAlive).toHaveBeenCalledWith(4242);
    expect(killProcessGroupSpy).toHaveBeenCalledWith(4242);
    // H2 ②：kill detached watchdog（--parent-pid=<mcpPid> 精确锚定）
    expect(execPkillSpy).toHaveBeenCalledTimes(1);
    const cmd = execPkillSpy.mock.calls[0]![0] as string;
    expect(cmd).toContain('pkill -9 -f');
    expect(cmd).toContain('chrome-devtools-mcp');
    expect(cmd).toContain('--parent-pid=4242');
  });

  it('[v0.0.337 H2] handshake 失败（无 transport.pid）→ killProcessGroup/pkill 跳过不阻断（退化为 graceful close）', async () => {
    const killProcessGroupSpy = vi.fn((_pid: number) => {});
    const execPkillSpy = vi.fn((_cmd: string) => {});
    const killDeps = {
      isPidAlive: vi.fn(() => true),
      killProcessGroup: killProcessGroupSpy,
      execPkill: execPkillSpy,
    };
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      connectShouldFail: new Error('Could not connect to Chrome: ECONNREFUSED 127.0.0.1:9222'),
      callToolCalls: [],
      callToolResult: { content: [] },
      // 无 transportPid
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state), killDeps });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({ kind: 'attach_failed' });
    expect(killProcessGroupSpy).not.toHaveBeenCalled(); // 无 pid 跳过 kill 组
    expect(execPkillSpy).not.toHaveBeenCalled(); // 无 pid 跳过 watchdog pkill
  });

  it('[v0.0.337 H2] pid 已死 → killProcessGroup 不调（isPidAlive=false，避免杀错进程）', async () => {
    const killProcessGroupSpy = vi.fn((_pid: number) => {});
    const killDeps = {
      isPidAlive: vi.fn(() => false),
      killProcessGroup: killProcessGroupSpy,
      execPkill: vi.fn(),
    };
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: {
        isError: true,
        content: [{ type: 'text', text: 'Could not connect to Chrome...' }],
      },
      transportPid: 4242,
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state), killDeps });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({ kind: 'attach_failed' });
    expect(killProcessGroupSpy).not.toHaveBeenCalled();
  });

  it('[v0.0.337 H2] win32 跳过 watchdog pkill（kill 组照常；pkill 仅 unix）', async () => {
    const killProcessGroupSpy = vi.fn((_pid: number) => {});
    const execPkillSpy = vi.fn((_cmd: string) => {});
    const killDeps = {
      isPidAlive: vi.fn(() => true),
      killProcessGroup: killProcessGroupSpy,
      execPkill: execPkillSpy,
    };
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: {
        isError: true,
        content: [{ type: 'text', text: 'Could not connect to Chrome...' }],
      },
      transportPid: 4242,
    };
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state), killDeps });
      await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({ kind: 'attach_failed' });
      expect(killProcessGroupSpy).toHaveBeenCalledWith(4242); // kill 组照常
      expect(execPkillSpy).not.toHaveBeenCalled(); // win32 跳过 watchdog
    } finally {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  // ---- v0.0.337 H3：signal abort 感知（abort → attach_failed → 走 catch → H2 清理） ----
  it('[v0.0.337 H3] handshake 挂起 + signal abort → 抛 attach_failed + killDeps 清理被调（abort 触发 catch 清理）', async () => {
    const killProcessGroupSpy = vi.fn((_pid: number) => {});
    const killDeps = {
      isPidAlive: vi.fn(() => true),
      killProcessGroup: killProcessGroupSpy,
      execPkill: vi.fn(),
    };
    const factory: McpFactory = {
      create() {
        const client: McpClient = {
          listTools: async () => ({ tools: [{ name: 'list_pages' }] }),
          callTool: async () => ({ content: [] }),
          close: async () => {},
        };
        const transport: McpTransport = { close: async () => {}, pid: 4242 };
        return { client, transport };
      },
      // handshake 永不 settle（模拟超时挂起）——abort 是唯一出路
      async connect() { return new Promise<void>(() => {}); },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: factory, killDeps });
    const ac = new AbortController();
    const p = driver.connect({ profileName: 'p1' }, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: 'attach_failed' });
    // abort → withAbort 抛 attach_failed → catch → H2 清理（kill 组 + watchdog）
    expect(killProcessGroupSpy).toHaveBeenCalledWith(4242);
  });

  it('[v0.0.337 H3] signal 已 aborted → 立即抛 attach_failed（不进入连接流程）', async () => {
    const killDeps = { isPidAlive: vi.fn(), killProcessGroup: vi.fn(), execPkill: vi.fn() };
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state), killDeps });
    const ac = new AbortController();
    ac.abort();
    await expect(driver.connect({ profileName: 'p1' }, ac.signal)).rejects.toMatchObject({
      kind: 'attach_failed',
    });
  });

  // ---- v0.0.337 H5：lastSpawnPid（spawn 即记，失败也可读；disconnect 清） ----
  it('[v0.0.337 H5] connect 失败（probe isError）→ getLastSpawnPid() 返回 transport.pid（失败也可读，供 H9 入台账兜底）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: {
        isError: true,
        content: [{ type: 'text', text: 'Could not connect to Chrome...' }],
      },
      transportPid: 4242,
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await expect(driver.connect({ profileName: 'p1' })).rejects.toMatchObject({ kind: 'attach_failed' });
    expect(driver.getLastSpawnPid()).toBe(4242); // 失败也记（spawn 即记）
  });

  it('[v0.0.337 H5] connect 成功 → getLastSpawnPid() 返回 pid；disconnect 清 undefined（与 lastMcpPid 同步清）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
      transportPid: 4242,
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await driver.connect({ profileName: 'p1' });
    expect(driver.getLastSpawnPid()).toBe(4242);
    await driver.disconnect({ profileName: 'p1' });
    expect(driver.getLastSpawnPid()).toBeUndefined();
  });
});

describe('ChromeMcpDriver：session 缓存', () => {
  it('同 profile 两次 connect → 只 create 一次（复用）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await driver.connect({ profileName: 'p1' });
    await driver.connect({ profileName: 'p1' });
    expect(state.createCalls).toHaveLength(1);
  });

  it('不同 profile → 各自 create（不混用）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await driver.connect({ profileName: 'p1' });
    await driver.connect({ profileName: 'p2' });
    expect(state.createCalls).toHaveLength(2);
  });

  it('[v0.0.334] 缓存 key=[profileName,userDataDir] 二元组：同 profile 同 userDataDir 复用，不同 userDataDir 新连', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await driver.connect({ profileName: 'p1' });
    await driver.connect({ profileName: 'p1' });
    await driver.connect({ profileName: 'p1', userDataDir: '/tmp/brave' });
    expect(state.createCalls).toHaveLength(2);
    // 恒 autoConnect（无 cdpUrl/browserUrl 维度）
    expect(state.createCalls[0]!.args).toContain('--autoConnect');
    expect(state.createCalls[1]!.args).toContain('--userDataDir');
    expect(state.createCalls[1]!.args).toContain('/tmp/brave');
  });

  it('[v0.0.334 B7] connect 成功且 transport.pid 存在 → getLastMcpPid() 返回该 pid（attach 台账锚点）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
      transportPid: 4242,
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await driver.connect({ profileName: 'p1' });
    expect(driver.getLastMcpPid()).toBe(4242);
  });

  it('[v0.0.334 B7] transport 无 pid → getLastMcpPid() undefined（不阻塞 attach）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await driver.connect({ profileName: 'p1' });
    expect(driver.getLastMcpPid()).toBeUndefined();
  });

  it('[v0.0.334 B7] disconnect 命中带 pid 的缓存 → getLastMcpPid() 清空（防 stale 台账锚点）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
      transportPid: 4242,
    };
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    await driver.connect({ profileName: 'p1' });
    expect(driver.getLastMcpPid()).toBe(4242);
    await driver.disconnect({ profileName: 'p1' });
    expect(driver.getLastMcpPid()).toBeUndefined();
  });
});

describe('ChromeMcpSession：MCP tool 映射（v0.0.29 BUG-006 对齐 chrome-devtools-mcp 1.4.0）', () => {
  async function makeSession(state: MockState) {
    const driver = new ChromeMcpDriver({ mcpFactory: makeMockFactory(state) });
    return driver.connect({ profileName: 'p1' });
  }

  it('listPages → list_pages {}（非 page-scoped，不带 pageId）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      // chrome-devtools-mcp 实际输出：pages[].id 是 number（非 string）
      callToolResult: {
        structuredContent: {
          pages: [
            { id: 1, url: 'https://a', selected: false },
            { id: 2, url: 'https://b', selected: true },
          ],
        },
      },
    };
    const s = await makeSession(state);
    // [v0.0.34] connect probe 已调一次 list_pages，重置计数让 [0] 是下面显式 listPages（去脆弱）
    state.callToolCalls.length = 0;
    const pages = await s.listPages();
    // arguments:{} 必传——chrome-devtools-mcp 1.4.0 ToolHandler 要求 arguments 是 object
    // （漏了报 "expected object, received undefined" → structuredContent 缺 → listPages 空）
    expect(state.callToolCalls[0]).toEqual({ name: 'list_pages', arguments: {} });
    // id number → string 转换；selected 透传
    expect(pages).toEqual([
      { id: '1', url: 'https://a', selected: false },
      { id: '2', url: 'https://b', selected: true },
    ]);
  });

  it('selectPage("3") → select_page {pageId:3(number)}，并设 activePageId', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const s = await makeSession(state);
    // [v0.0.34] connect probe 已调一次 list_pages，重置让 [0]/[1] 为下面的 select_page/navigate_page
    state.callToolCalls.length = 0;
    await s.selectPage('3');
    expect(state.callToolCalls[0]).toEqual({
      name: 'select_page',
      arguments: { pageId: 3 },
    });
    // 后续 navigate 应复用 activePageId=3，不再 listPages 兜底
    await s.navigate('https://x');
    expect(state.callToolCalls[1]).toEqual({
      name: 'navigate_page',
      arguments: { type: 'url', url: 'https://x', pageId: 3 },
    });
  });

  it('navigate(url) 先 selectPage 设 activePageId → navigate_page {type:"url",url,pageId}', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const s = await makeSession(state);
    await s.selectPage('5');
    state.callToolCalls.length = 0;
    await s.navigate('https://example.com');
    expect(state.callToolCalls[0]).toEqual({
      name: 'navigate_page',
      arguments: { type: 'url', url: 'https://example.com', pageId: 5 },
    });
  });

  it('navigate(url) 未设 activePageId → 自动 listPages 兜底取 selected 页', async () => {
    // [v0.0.34] connect probe + ensurePageId 两次 list_pages 都返 selected 页（按 tool 名返回，不靠调用序号）
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const factory: McpFactory = {
      create(opts) {
        state.createCalls.push({ command: opts.command, args: opts.args });
        const client: McpClient = {
          listTools: async () => ({ tools: state.listToolsNames.map((n) => ({ name: n })) }),
          callTool: async (req) => {
            state.callToolCalls.push({ name: req.name, arguments: req.arguments });
            // probe 与 ensurePageId 的 list_pages 都返 selected 页；其它工具返默认
            if (req.name === 'list_pages') {
              return {
                structuredContent: {
                  pages: [{ id: 9, url: 'https://sel', selected: true }],
                },
              };
            }
            return state.callToolResult;
          },
          close: async () => {},
        };
        const transport: McpTransport = { close: async () => {} };
        return { client, transport };
      },
      async connect() {},
    };
    const driver = new ChromeMcpDriver({ mcpFactory: factory });
    const s = await driver.connect({ profileName: 'p1' });
    // 清掉 connect probe 的 list_pages，只断言 navigate 触发的兜底序列
    state.callToolCalls.length = 0;
    await s.navigate('https://example.com');
    // list_pages arguments:{}（BUG-006 修复后必传 object，非 undefined）
    expect(state.callToolCalls).toEqual([
      { name: 'list_pages', arguments: {} },
      { name: 'navigate_page', arguments: { type: 'url', url: 'https://example.com', pageId: 9 } },
    ]);
  });

  it('click(ref) → click {uid:ref,pageId}（ref 即 uid）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const s = await makeSession(state);
    // 先 selectPage 设 activePageId，避免 click 触发 listPages 兜底
    await s.selectPage('7');
    state.callToolCalls.length = 0;
    await s.click('1_3');
    expect(state.callToolCalls[0]).toEqual({
      name: 'click',
      arguments: { uid: '1_3', pageId: 7 },
    });
  });

  it('type(ref,text) → fill {uid:ref,value:text,pageId}（chrome-devtools-mcp 无 type 工具）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const s = await makeSession(state);
    await s.selectPage('2');
    state.callToolCalls.length = 0;
    await s.type('2_0', 'hello');
    expect(state.callToolCalls[0]).toEqual({
      name: 'fill',
      arguments: { uid: '2_0', value: 'hello', pageId: 2 },
    });
  });

  it('evaluate(script) → evaluate_script {function:script,pageId}（字段是 function 不是 script）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { structuredContent: { result: 42 } },
    };
    const s = await makeSession(state);
    await s.selectPage('4');
    state.callToolCalls.length = 0;
    const r = await s.evaluate('() => document.title');
    expect(state.callToolCalls[0]).toEqual({
      name: 'evaluate_script',
      arguments: { function: '() => document.title', pageId: 4 },
    });
    expect(r).toEqual({ result: 42 });
  });

  it('snapshot → take_snapshot {pageId}（工具名是 take_snapshot 不是 snapshot）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: {
        structuredContent: {
          snapshot: {
            role: 'root',
            name: 'page',
            children: [
              { id: '1_0', role: 'button', name: 'Go' },
            ],
          },
        },
      },
    };
    const s = await makeSession(state);
    await s.selectPage('6');
    state.callToolCalls.length = 0;
    const r = await s.snapshot();
    expect(state.callToolCalls[0]).toEqual({
      name: 'take_snapshot',
      arguments: { pageId: 6 },
    });
    // snapshot 解析：button 建 ref，uid=1_0
    expect(r.refs['1_0']).toEqual({ role: 'button', name: 'Go', nth: 0 });
  });

  it('page-scoped 操作无 activePageId 且 listPages 也无页 → attach_failed', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { structuredContent: { pages: [] } },
    };
    const s = await makeSession(state);
    await expect(s.navigate('https://x')).rejects.toMatchObject({
      kind: 'attach_failed',
    });
  });

  it('close → no-op（不抛，attach 不杀用户 chrome）', async () => {
    const state: MockState = {
      createCalls: [],
      listToolsNames: ['list_pages'],
      callToolCalls: [],
      callToolResult: { content: [] },
    };
    const s = await makeSession(state);
    await expect(s.close()).resolves.toBeUndefined();
  });
});

describe('extractPages / parsePageIdNumber（v0.0.29 BUG-006 辅助）', () => {
  it('extractPages：id 非 number 的项被过滤', () => {
    const pages = extractPages({
      pages: [
        { id: 1, url: 'https://a' },
        { id: 'bad', url: 'https://b' },
        { id: 3, url: 'https://c', selected: true },
        { id: 4 },
      ],
    });
    expect(pages).toEqual([
      { id: '1', url: 'https://a', selected: false },
      { id: '3', url: 'https://c', selected: true },
    ]);
  });

  it('extractPages：structuredContent 非 {pages:[]} → []', () => {
    expect(extractPages(undefined)).toEqual([]);
    expect(extractPages({})).toEqual([]);
    expect(extractPages({ pages: 'notarray' })).toEqual([]);
  });

  it('parsePageIdNumber：正整数字符串 → number', () => {
    expect(parsePageIdNumber('1')).toBe(1);
    expect(parsePageIdNumber('42')).toBe(42);
  });

  it('parsePageIdNumber：非正整数 → attach_failed', () => {
    expect(() => parsePageIdNumber('0')).toThrow(BrowserError);
    expect(() => parsePageIdNumber('-1')).toThrow(BrowserError);
    expect(() => parsePageIdNumber('abc')).toThrow(BrowserError);
    expect(() => parsePageIdNumber('1.5')).toThrow(BrowserError);
  });
});

describe('parseChromeMcpSnapshot（v0.0.29 BUG-006：a11y 树 → rocky SnapshotResult）', () => {
  it('INTERACTIVE role 全建 ref（uid = 节点 id）', () => {
    const tree = {
      snapshot: {
        role: 'root',
        name: 'page',
        children: [
          { id: '1_0', role: 'button', name: 'Submit' },
          { id: '1_1', role: 'link', name: 'Home' },
          { id: '1_2', role: 'textbox', name: 'Search' },
        ],
      },
    };
    const r = parseChromeMcpSnapshot(tree);
    expect(r.refs['1_0']).toEqual({ role: 'button', name: 'Submit', nth: 0 });
    expect(r.refs['1_1']).toEqual({ role: 'link', name: 'Home', nth: 0 });
    expect(r.refs['1_2']).toEqual({ role: 'textbox', name: 'Search', nth: 0 });
    // 文本树含 ref 标记
    expect(r.snapshot).toContain('[ref=1_0]');
    expect(r.snapshot).toContain('button "Submit"');
  });

  it('CONTENT role 有 name 才建 ref；无 name 不建', () => {
    const tree = {
      snapshot: {
        role: 'main',
        children: [
          { id: '1_0', role: 'heading', name: 'Title' },
          { id: '1_1', role: 'region' },
          { id: '1_2', role: 'region', name: 'Sidebar' },
        ],
      },
    };
    const r = parseChromeMcpSnapshot(tree);
    expect(r.refs['1_0']).toEqual({ role: 'heading', name: 'Title', nth: 0 });
    expect(r.refs['1_1']).toBeUndefined();
    expect(r.refs['1_2']).toEqual({ role: 'region', name: 'Sidebar', nth: 0 });
  });

  it('结构性 role（generic/list/...）无 name 时跳过输出，但递归子节点', () => {
    const tree = {
      snapshot: {
        role: 'generic',
        children: [
          { id: '1_0', role: 'button', name: 'OK' },
        ],
      },
    };
    const r = parseChromeMcpSnapshot(tree);
    // generic 自身不输出（无 name），但子 button 输出且建 ref
    expect(r.refs['1_0']).toEqual({ role: 'button', name: 'OK', nth: 0 });
    expect(r.snapshot).not.toMatch(/^- generic/);
  });

  it('同 role+name 重复时 nth 递增（从 0 起）', () => {
    const tree = {
      snapshot: {
        role: 'root',
        children: [
          { id: '1_0', role: 'button', name: 'X' },
          { id: '1_1', role: 'button', name: 'X' },
          { id: '1_2', role: 'button', name: 'X' },
        ],
      },
    };
    const r = parseChromeMcpSnapshot(tree);
    expect(r.refs['1_0']).toEqual({ role: 'button', name: 'X', nth: 0 });
    expect(r.refs['1_1']).toEqual({ role: 'button', name: 'X', nth: 1 });
    expect(r.refs['1_2']).toEqual({ role: 'button', name: 'X', nth: 2 });
  });

  it('输入异常（null/非对象/无 snapshot 字段）→ 空 SnapshotResult，不抛', () => {
    expect(parseChromeMcpSnapshot(null)).toEqual({ snapshot: '', refs: {} });
    expect(parseChromeMcpSnapshot('string')).toEqual({ snapshot: '', refs: {} });
    expect(parseChromeMcpSnapshot({})).toEqual({ snapshot: '', refs: {} });
    expect(parseChromeMcpSnapshot({ snapshot: 'notobject' })).toEqual({ snapshot: '', refs: {} });
  });

  it('根节点直接是 a11y 树（无 snapshot 包裹）也能解析', () => {
    const root = {
      role: 'root',
      children: [{ id: '1_0', role: 'button', name: 'Go' }],
    };
    const r = parseChromeMcpSnapshot(root);
    expect(r.refs['1_0']).toEqual({ role: 'button', name: 'Go', nth: 0 });
  });
});

describe('isAttachConnectError', () => {
  it('ECONNREFUSED → true', () => {
    expect(isAttachConnectError(new Error('ECONNREFUSED 127.0.0.1:9222'))).toBe(true);
  });
  it('普通错误 → false', () => {
    expect(isAttachConnectError(new Error('timeout'))).toBe(false);
  });
});

describe('ChromeMcpDriver.disconnect（v0.0.29 BUG-007：graceful client.close + kill 兜底）', () => {
  /**
   * 断言语义（对齐 openclaw closeChromeMcpClientAndProcess）：
   *   - cache 命中 → delete 缓存
   *   - session.close()（no-op 占位）
   *   - client.close()（graceful，触发 closeBrowser + puppeteer.disconnect）
   *   - transport.close()（kill 兜底）
   * 三步各自独立 try/catch，任一失败不阻断后续。
   */
  it('disconnect 命中缓存 → session.close + client.close + transport.close 都被调，缓存被清', async () => {
    const sessionClose = vi.fn(async () => {});
    const clientClose = vi.fn(async () => {});
    const transportClose = vi.fn(async () => {});
    const factory: McpFactory = {
      create() {
        const client: McpClient = {
          listTools: async () => ({ tools: [{ name: 'list_pages' }] }),
          callTool: async () => ({ content: [] }),
          close: clientClose,
        };
        const transport: McpTransport = { close: transportClose };
        return { client, transport };
      },
      async connect() {},
    };
    const driver = new ChromeMcpDriver({ mcpFactory: factory });
    // 先 connect 建缓存（session.close 注入 spy via ChromeMcpSession 间接，这里直接验证 session 接口）
    const session = await driver.connect({ profileName: 'p1' });
    session.close = sessionClose;
    // 同 profile disconnect 应命中缓存
    await driver.disconnect({ profileName: 'p1' });
    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(transportClose).toHaveBeenCalledTimes(1);
    // 缓存被清：再 connect 同 profile 会重新 create
    await driver.connect({ profileName: 'p1' });
  });

  it('disconnect cache miss → no-op（幂等，不抛）', async () => {
    const factory: McpFactory = {
      create() {
        const client: McpClient = {
          listTools: async () => ({ tools: [{ name: 'list_pages' }] }),
          callTool: async () => ({ content: [] }),
          close: vi.fn(async () => {}),
        };
        const transport: McpTransport = { close: vi.fn(async () => {}) };
        return { client, transport };
      },
      async connect() {},
    };
    const driver = new ChromeMcpDriver({ mcpFactory: factory });
    // 从未 connect → cache miss，disconnect 不抛
    await expect(driver.disconnect({ profileName: 'never' })).resolves.toBeUndefined();
  });

  it('disconnect：graceful 失败（client.close 抛错）不阻断 kill 兜底（transport.close 仍被调）', async () => {
    const sessionClose = vi.fn(async () => {});
    const clientClose = vi.fn(async () => {
      throw new Error('client.close boom');
    });
    const transportClose = vi.fn(async () => {});
    const factory: McpFactory = {
      create() {
        const client: McpClient = {
          listTools: async () => ({ tools: [{ name: 'list_pages' }] }),
          callTool: async () => ({ content: [] }),
          close: clientClose,
        };
        const transport: McpTransport = { close: transportClose };
        return { client, transport };
      },
      async connect() {},
    };
    const driver = new ChromeMcpDriver({ mcpFactory: factory });
    const session = await driver.connect({ profileName: 'p1' });
    session.close = sessionClose;
    // client.close 抛错 → 不应冒泡，transport.close 仍执行
    await expect(driver.disconnect({ profileName: 'p1' })).resolves.toBeUndefined();
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(transportClose).toHaveBeenCalledTimes(1);
  });

  it('disconnect：transport.close 抛错（client.close 已关 transport 重复关场景）不阻断、不冒泡', async () => {
    const clientClose = vi.fn(async () => {});
    const transportClose = vi.fn(async () => {
      throw new Error('transport already closed');
    });
    const factory: McpFactory = {
      create() {
        const client: McpClient = {
          listTools: async () => ({ tools: [{ name: 'list_pages' }] }),
          callTool: async () => ({ content: [] }),
          close: clientClose,
        };
        const transport: McpTransport = { close: transportClose };
        return { client, transport };
      },
      async connect() {},
    };
    const driver = new ChromeMcpDriver({ mcpFactory: factory });
    const session = await driver.connect({ profileName: 'p1' });
    session.close = vi.fn(async () => {});
    await expect(driver.disconnect({ profileName: 'p1' })).resolves.toBeUndefined();
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(transportClose).toHaveBeenCalledTimes(1);
  });
});
