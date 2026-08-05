/**
 * ContentFetcher 契约（接口）+ 共享类型
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3.1（v1.3 架构重构）
 *
 * 设计意图（spec §6.1）：
 *   抽象统一的 ContentFetcher 接口，让 race runner 不感知实现差异。
 *   2 个实现：JinaContentFetcher（r.jina.ai）/ LocalContentFetcher（静态 + headless 子分支）。
 *   新增实现（未来 firecrawl/proxy pool）只需实现本接口并注册到 race runner。
 *
 * 契约要点（spec §3.1）：
 *   - signal 构造注入：`new XxxContentFetcher({ signal, ... })`，fetcher 内部存 signal 字段，
 *     所有子操作（jina fetch / 本地静态 / local 起 chromium）一开始就接好 abort。
 *   - fetch 不抛：失败/不充足返回 ok:false（带空 content），让 runner 用 Promise.any 跑完 race。
 *   - 合格判定在 runner（不在 fetcher）：fetcher 只报「拿到了什么」。
 *   - cleanup() 独立方法：runner 在 race 结束后对每个 fetcher 调一次，detached。
 */

/** 单次 fetch 的上下文（race runner 构造 fetcher 后调 fetch 时传入） */
export interface FetchContext {
  /** 目标 URL（已通过 SSRF 校验，公网） */
  url: string;
}

/** fetch 结果 */
export interface FetchResult {
  /** 标题（readability/title 提供；无则空） */
  title: string;
  /** markdown 正文（调用方再 wrap + truncate） */
  content: string;
  /** 内容来源：jina / local / headless（headless 由 Local 内部产生，标 source 区分） */
  source: 'jina' | 'local' | 'headless';
  /** true = 拿到合格内容；false = 失败/不充足（content 可能为空） */
  ok: boolean;
  /** 失败原因（ok=false 时填，观测用途：race runner 透出给上层写 error.log 定位哪路为何挂） */
  err?: string;
}

/**
 * 内容抓取者契约。2 个实现：JinaContentFetcher / LocalContentFetcher。
 *
 * signal 通过构造注入（非 fetch 参数）——fetcher 从出生持有 abort，
 * 内部所有子操作一开始就接好此 signal（spec §6.2 反例：后传有时序窗口）。
 */
export interface ContentFetcher {
  /** 实现标识 */
  id: 'jina' | 'local';
  /**
   * 抓取。signal 由构造注入；实现内所有子操作必须接好此 signal。
   * 胜出由 runner 判定（合格 = ok && trim(content) ≥ MIN_CONTENT）；
   * 本方法只负责「尽最大努力拿内容」，返回 ok=false 不抛（让 runner 跑完 race）。
   */
  fetch(ctx: FetchContext): Promise<FetchResult>;
  /**
   * 资源清理（detached，best-effort，不抛）。
   * runner 在 race 结束（无论胜败）后调用一次；实现内须保证：
   * 即使 fetch 被 abort 中断，finally 关掉所有 dispatcher/浏览器。
   */
  cleanup(): Promise<void>;
}
