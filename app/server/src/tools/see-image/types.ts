/**
 * see_image 子系统协议类型（SeeImageProvider 契约权威源）
 * 参考: specs/tech/agent/tools/[P1]see_image_tool.md §2
 *
 * 与 web-search/types.ts 的 WebSearchProvider 完全同构（范式蓝本）：
 * understand/isAvailable 带 cfg 入参（不透明 map）；凭证不进协议（cfg 由 tool 从
 * app_config.see_image 构造传入）；impl 不得从 this.cfg / env 读凭证，统一从运行时入参 cfg 读。
 *
 * 硬约束：SeeImageResult 只含文字理解 + 元数据，MUST NOT 含 base64 / 图片二进制。
 * understand() 的 imagePaths 参数是 **绝对路径**（tool 层已用 ctx.workdir resolve + 校验存在/
 * 图片格式），provider 内部读文件 → base64 只发生在出站传输环节，不回流到协议返回值。
 */

/**
 * 视觉理解结果（provider.understand 返回值）。
 * MUST NOT 含 base64/图片二进制——硬约束贯穿本工具全链路。
 */
export interface SeeImageResult {
  /** provider.id */
  provider: string;
  /** vender 对「图片 + 文字」的综合理解文本 */
  text: string;
  /** imagePaths.length */
  count: number;
  /** 耗时 ms */
  tookMs: number;
}

/**
 * 不透明配置 map。
 * 由 tool 从 `app_config.see_image.credentials[type]` 构造，每次调用传入 impl。
 * 协议不规定字段，由 impl 自定义（minimax_m3 / zhipu_image 均期望 `{ apiKey?: string }`）。
 */
export type SeeImageCfg = Record<string, unknown>;

/**
 * 视觉理解后端提供方契约（由插件 ext impl 实现）。
 * 凭证归 app_config see_image group，不进协议；
 * impl 从运行时入参 cfg 读凭证，禁从 this.cfg / env 读。
 */
export interface SeeImageProvider {
  /** provider 唯一 id（snake_case，与 ext impl implId 对应） */
  id: string;
  /** 展示名（配置 UI / 错误提示用） */
  label: string;
  /**
   * 是否可用（如凭证是否配置）。**禁止做 I/O**（只查内存 cfg.apiKey），否则每次 assemble 阻塞。
   * cfg 由 tool 从 app_config.see_image.credentials[type] 构造传入。
   * 返回 false → Tool 返精确错误（"vender X 不可用 / 凭证未配置"），不静默换 vender。
   */
  isAvailable(cfg: SeeImageCfg): boolean;
  /**
   * 执行视觉理解。
   * @param text       提问文字（可空串）
   * @param imagePaths **绝对路径数组**（tool 已用 ctx.workdir resolve + 校验存在/图片格式）；顺序有语义
   * @param cfg        不透明 map（tool 从 app_config 构造，含 apiKey）
   * @param signal     取消信号（透传 ctx.signal）
   *
   * 读文件 → base64 只在本方法内部完成；出站 fetch 走 proxyFetch（带 SSRF 守卫 + 代理）。
   * 失败（key 空 / API 错误 / vender 能力限制如 zhipu 图数≠1）抛 Error → tool 层 catch 转 ToolError。
   */
  understand(
    text: string,
    imagePaths: string[],
    cfg: SeeImageCfg,
    signal?: AbortSignal,
  ): Promise<SeeImageResult>;
}
