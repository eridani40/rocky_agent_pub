/**
 * @app/computer-native 类型声明 —— Swift dylib + N-API 桥暴露的 addon 面。
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.2
 */

export interface RockyComputerAddon {
  /** 同步健康探针（Spike 0）：返回 Swift 侧固定 JSON 串（如 {"ok":true,"pong":"pong",...}） */
  ping(): string;
  /** 异步业务入口（Spike 1+）：method + JSON params → Promise<JSON 结果串> */
  invoke(method: string, paramsJson: string): Promise<string>;
}

/** 加载失败（非 darwin / 未构建）→ undefined（fail-closed，见 index.js） */
declare const addon: RockyComputerAddon | undefined;
export = addon;
