/**
 * LoopbackComputerNativePort —— dev 模式 agent 原生桌面能力走通到主进程 native addon 的桥
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2.md §5.5 P0-G（dev loopback 通道）
 *       specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §P1-D（/invoke 泛路由）
 *
 * 根因（§5.5）：dev 三进程 = ① Electron 主进程（TCC 权限主体，加载 native addon，但 dev 不起后端）
 *   ② 独立 bun 后端（agent 工具在此进程跑，够不到主进程 native addon）③ vite。
 *   agent 原生动作走 bun 后端，够不到主进程原生能力 —— 这是 dev 原生能力断链的根因。
 *
 * 方案（选项 D，覆盖旧「须打包」结论）：Electron 主进程（dev 也常驻）额外开一个
 *   127.0.0.1 loopback 通道暴露 permissions/screenshot/invoke；本类是 bun 后端侧的**纯 fetch** 适配，
 *   把「bun 后端 → 主进程 native addon（ScreenCaptureKit + AX + postToPid）」的最后一跳桥起来。
 *   跨进程走 JSON over HTTP，比直调更贴近真实序列化路径；底层 native addon 调用与 packaged 完全相同。
 *
 * 通道：GET /permissions + POST /screenshot（专属端点）+ POST /invoke {method,params}
 *   （getAppState/readAxTree/listApps/click/type/scroll/pressKey/drag/setValue/performSecondaryAction
 *   走 generic 单路由——主进程按 method 分发 `port.<method>(...params)`，免为每个动作开专属端点）。
 *
 * 不变量：
 *   - **MUST** 零 electron（纯 global fetch）；**MUST NOT** import electron。
 *   - **MUST** fetch 异常 fail-closed 不抛穿 tool（checkPermissions 返双 missing / 其余返 ok:false）。
 */
import {
  coercePermissions,
  type AppInfo,
  type AxTreeOptions,
  type AxTreeResult,
  type ClickOptions,
  type ComputerActionResult,
  type ComputerNativePort,
  type ComputerPermissions,
  type ComputerScreenshotOptions,
  type ComputerScreenshotResult,
  type ComputerTarget,
  type DragOptions,
  type GetAppStateOptions,
  type GetAppStateResult,
  type PixelPoint,
  type PressKeyOptions,
  type ScrollOptions,
  type SecondaryActionOptions,
  type SetValueOptions,
  type TypeOptions,
} from './native-port';

/** dev token header 名（主进程 loopback server 校验同名，防同机其他进程误撞截图端点） */
const DEV_TOKEN_HEADER = 'x-rocky-dev-token';

/**
 * LoopbackComputerNativePort —— 纯 fetch 调主进程 loopback 通道。
 */
export class LoopbackComputerNativePort implements ComputerNativePort {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', [DEV_TOKEN_HEADER]: this.token };
  }

  /** GET /permissions；fetch 抛/非 2xx → 双 missing（fail-closed，不崩不阻断 tool） */
  async checkPermissions(): Promise<ComputerPermissions> {
    try {
      const res = await fetch(`${this.baseUrl}/permissions`, { headers: this.headers() });
      if (!res.ok) return { accessibility: 'missing', screenRecording: 'missing' };
      return coercePermissions(await res.json());
    } catch {
      return { accessibility: 'missing', screenRecording: 'missing' };
    }
  }

  /** POST /screenshot（body=opts）；fetch 抛/非 2xx → {ok:false,reason}（fail-closed） */
  async screenshot(opts?: ComputerScreenshotOptions): Promise<ComputerScreenshotResult> {
    try {
      const res = await fetch(`${this.baseUrl}/screenshot`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(opts ?? {}),
      });
      if (!res.ok) {
        return { ok: false, reason: `loopback screenshot HTTP ${res.status}` };
      }
      const body = (await res.json()) as ComputerScreenshotResult;
      // 校验主进程回传形状（ok 必为 boolean；缺失 → 视为失败 fail-closed）
      if (typeof body?.ok !== 'boolean') {
        return { ok: false, reason: 'loopback screenshot: malformed response' };
      }
      return body;
    } catch (e) {
      return { ok: false, reason: `loopback screenshot unreachable: ${errMsg(e)}` };
    }
  }

  /**
   * app 状态合一：POST /invoke {method:'getAppState', params:[opts]}；fetch 抛/非 2xx/形状非法 → {ok:false,reason}。
   */
  async getAppState(opts?: GetAppStateOptions): Promise<GetAppStateResult> {
    try {
      const body = (await this.invoke('getAppState', [opts])) as GetAppStateResult;
      if (typeof body?.ok !== 'boolean') {
        return { ok: false, reason: 'loopback getAppState: malformed response' };
      }
      return body;
    } catch (e) {
      return { ok: false, reason: `loopback getAppState unreachable: ${errMsg(e)}` };
    }
  }

  /** 列运行中 app：POST /invoke {method:'listApps', params:[]}；fetch 抛/非 2xx/非数组 → 空数组（fail-closed 不阻断） */
  async listApps(): Promise<AppInfo[]> {
    try {
      const body = await this.invoke('listApps', []);
      return Array.isArray(body) ? (body as AppInfo[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * 读 AX 树：POST /invoke {method:'readAxTree', params:[opts]}；fetch 抛/非 2xx/形状非法 → {ok:false,reason}。
   * generic /invoke 通道（主进程按 method 分发 `port.readAxTree(...params)`），免专属端点。
   */
  async readAxTree(opts?: AxTreeOptions): Promise<AxTreeResult> {
    try {
      const body = (await this.invoke('readAxTree', [opts])) as AxTreeResult;
      if (typeof body?.ok !== 'boolean') {
        return { ok: false, reason: 'loopback readAxTree: malformed response' };
      }
      return body;
    } catch (e) {
      return { ok: false, reason: `loopback readAxTree unreachable: ${errMsg(e)}` };
    }
  }

  /** 点击：POST /invoke {method:'click', params:[target,opts]} */
  async click(target: ComputerTarget, opts?: ClickOptions): Promise<ComputerActionResult> {
    return this.action('click', [target, opts]);
  }

  /** 输入文本：POST /invoke {method:'type', params:[text,opts]} */
  async type(text: string, opts?: TypeOptions): Promise<ComputerActionResult> {
    return this.action('type', [text, opts]);
  }

  /** 滚动：POST /invoke {method:'scroll', params:[target,opts]} */
  async scroll(target: ComputerTarget, opts: ScrollOptions): Promise<ComputerActionResult> {
    return this.action('scroll', [target, opts]);
  }

  /** 按键：POST /invoke {method:'pressKey', params:[keySpec,opts]} */
  async pressKey(keySpec: string, opts?: PressKeyOptions): Promise<ComputerActionResult> {
    return this.action('pressKey', [keySpec, opts]);
  }

  /** 拖拽：POST /invoke {method:'drag', params:[from,to,opts]} */
  async drag(from: PixelPoint, to: PixelPoint, opts?: DragOptions): Promise<ComputerActionResult> {
    return this.action('drag', [from, to, opts]);
  }

  /** 赋值：POST /invoke {method:'setValue', params:[elementIndex,value,opts]} */
  async setValue(elementIndex: number, value: string, opts?: SetValueOptions): Promise<ComputerActionResult> {
    return this.action('setValue', [elementIndex, value, opts]);
  }

  /** 次要动作：POST /invoke {method:'performSecondaryAction', params:[elementIndex,action,opts]} */
  async performSecondaryAction(
    elementIndex: number,
    action: string,
    opts?: SecondaryActionOptions,
  ): Promise<ComputerActionResult> {
    return this.action('performSecondaryAction', [elementIndex, action, opts]);
  }

  /** click/type/scroll/pressKey/drag/setValue/performSecondaryAction 共用：调 /invoke → 校验 ok:boolean → fail-closed */
  private async action(method: string, params: unknown[]): Promise<ComputerActionResult> {
    try {
      const body = (await this.invoke(method, params)) as ComputerActionResult;
      if (typeof body?.ok !== 'boolean') {
        return { ok: false, reason: `loopback ${method}: malformed response` };
      }
      return body;
    } catch (e) {
      return { ok: false, reason: `loopback ${method} unreachable: ${errMsg(e)}` };
    }
  }

  /** POST /invoke {method,params}；非 2xx 抛（由调用方 catch 转 fail-closed） */
  private async invoke(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/invoke`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ method, params }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

/** 从 unknown error 取消息串（fail-closed reason 用） */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 解析 dev loopback native port（bootstrap precedence 次高，低于 test-mock）。
 * `ROCKY_DEV_COMPUTER_LOOPBACK_PORT` 有值 → 建纯 fetch 的 loopback port；否则 undefined。
 *
 * @param env 进程环境（仅认 ROCKY_DEV_COMPUTER_LOOPBACK_PORT——仅 dev.env 设）
 * @returns loopback port（开关命中）或 undefined（未命中 → 下探 registry）
 */
export function resolveLoopbackComputerNativePort(
  env: NodeJS.ProcessEnv,
): ComputerNativePort | undefined {
  const port = env.ROCKY_DEV_COMPUTER_LOOPBACK_PORT;
  if (!port || port.trim() === '') return undefined;
  const token = env.ROCKY_DEV_COMPUTER_LOOPBACK_TOKEN ?? '';
  return new LoopbackComputerNativePort(`http://127.0.0.1:${port}`, token);
}
