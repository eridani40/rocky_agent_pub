'use strict';

/**
 * @app/computer-native 入口 —— 加载 node-gyp 构建产物 rocky_computer.node（Swift dylib + N-API 桥）。
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.2（addon 缺失 fail-closed）
 *
 * fail-closed：非 darwin / 未构建 / 加载失败 → 导出 undefined（不 throw）。
 * Electron 主进程侧（computer-native-port）据此降级：addon 缺失时各 native 方法返 {ok:false}。
 */
let addon;
try {
  // build/Release/rocky_computer.node 与 libRockyComputerCore.dylib 并置（rpath @loader_path 解析 dylib）
  addon = require('./build/Release/rocky_computer.node');
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('[computer-native] addon load failed (fail-closed → undefined):', err && err.message);
  addon = undefined;
}

module.exports = addon;
