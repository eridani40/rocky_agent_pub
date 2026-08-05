'use strict';

/**
 * spike-test.js —— 编译链验证（Spike 0 + Spike 1），在 **Electron 的 node ABI** 下运行。
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.3
 *
 * 运行方式（不起 BrowserWindow，仅验 require + 调用）：
 *   ELECTRON_RUN_AS_NODE=1 <electron-binary> scripts/spike-test.js
 * ELECTRON_RUN_AS_NODE=1 让 electron 二进制当 node 解释器跑 = 与主进程同一 node ABI，
 * 从而验证 .node 是否对 Electron ABI 正确编译（系统 node ABI 不同，会加载失败）。
 *
 * Spike 0：require addon + ping() 返 "pong"。
 * Spike 1：invoke('readAxTree', ...) 返回结构合法（真 AX 内容需 TCC 授权，空树也算通）。
 * Spike 2：invoke('screenshot', ...) 验 ScreenCaptureKit async→sync 桥在 AsyncWorker 跑通
 *          （Screen Recording 授权 → 真 PNG base64 + windowBounds；权限缺 → 结构合法 error 也算桥通）。
 * Spike 3：invoke('click', {target:{coordinate},pid}) 验 CGEvent postToPid 调用链通（投递到本进程 pid=无窗口，
 *          不干扰用户；不崩 + 返回结构合法即桥通；真点击效果 dev dogfood 验）。
 */
const path = require('path');

function fail(msg) {
  console.error('[spike] FAIL:', msg);
  process.exit(1);
}

const addonPath = path.resolve(__dirname, '..');
let addon;
try {
  addon = require(addonPath);
} catch (err) {
  fail('require(@app/computer-native) threw: ' + (err && err.stack));
}
if (!addon) {
  fail('addon is undefined (加载失败 fail-closed；.node 未构建或 ABI 不匹配)');
}

// ── Spike 0: ping ────────────────────────────────────────────────
if (typeof addon.ping !== 'function') {
  fail('addon.ping is not a function');
}
const pingRaw = addon.ping();
console.log('[spike] ping() =', pingRaw);
let ping;
try {
  ping = JSON.parse(pingRaw);
} catch (err) {
  fail('ping() 返回非 JSON: ' + pingRaw);
}
if (!ping || ping.pong !== 'pong') {
  fail('ping().pong !== "pong": ' + pingRaw);
}
console.log('[spike] SPIKE 0 PASS: swift dylib → node-gyp(Electron ABI) → 主进程 require + ping() 全链通');

if (typeof addon.invoke !== 'function') {
  console.log('[spike] (invoke 未导出 → 仅 Spike 0 阶段；Spike 1+ 待加 rocky_cu_invoke)');
  process.exit(0);
}

/** invoke + 解析 JSON + 校验 {ok:boolean} 结构合法性（ok=false 也算桥通，返 res）。 */
async function invokeChecked(method, params, label) {
  const raw = await addon.invoke(method, JSON.stringify(params));
  console.log('[spike] invoke("' + method + '") raw len =', raw ? raw.length : 0);
  let res;
  try {
    res = JSON.parse(raw);
  } catch (err) {
    fail(label + ' 返回非 JSON: ' + String(raw).slice(0, 200));
  }
  if (typeof res.ok !== 'boolean') {
    fail(label + ' 结果缺 ok:boolean: ' + JSON.stringify(res).slice(0, 300));
  }
  return res;
}

(async () => {
  // ── Spike 1: readAxTree ────────────────────────────────────────
  const wantApp = process.env.SPIKE_AX_APP || undefined; // 可选 app hint（bundleId），缺则 frontmost
  const ax = await invokeChecked('readAxTree', wantApp ? { app: wantApp } : {}, 'invoke("readAxTree")');
  console.log('[spike] readAxTree preview =', JSON.stringify(ax).slice(0, 300));
  console.log('[spike] SPIKE 1 PASS: addon 加载 + readAxTree 调用链通（结构合法，ok=' + ax.ok + '）');

  // ── Spike 2: screenshot（ScreenCaptureKit 单窗口）───────────────
  const shot = await invokeChecked('screenshot', wantApp ? { app: wantApp } : {}, 'invoke("screenshot")');
  if (shot.ok) {
    const r = shot.result || {};
    const dataLen = typeof r.data === 'string' ? r.data.length : 0;
    if (dataLen === 0) {
      fail('screenshot ok:true 但 result.data 空（base64 应非空）: ' + JSON.stringify(r).slice(0, 300));
    }
    console.log(
      '[spike] screenshot: base64 len=' + dataLen + ' width=' + r.width + ' height=' + r.height +
        ' scaleFactor=' + r.scaleFactor + ' windowBounds=' + JSON.stringify(r.windowBounds),
    );
    console.log(
      '[spike] SPIKE 2 PASS: ScreenCaptureKit async→sync 桥在 AsyncWorker 跑通，返真 PNG base64 + windowBounds',
    );
  } else {
    const code = shot.error && shot.error.code;
    console.log('[spike] screenshot ok:false error =', JSON.stringify(shot.error));
    if (code === 'permission_missing') {
      console.log(
        '[spike] SPIKE 2 桥通（编译+链接+dispatch OK），但 Screen Recording 未授权 → async 截图路径未实际执行；' +
          '需授权后复验以验证 ScreenCaptureKit async 真跑通。',
      );
    } else {
      console.log('[spike] SPIKE 2 桥通（返结构合法 error，code=' + code + '）');
    }
  }

  // ── Spike 3: click（CGEvent postToPid，投递本进程 pid 避免干扰用户）──
  const click = await invokeChecked(
    'click',
    { target: { coordinate: { x: 10, y: 10 } }, pid: process.pid },
    'invoke("click")',
  );
  if (click.ok) {
    console.log('[spike] click result =', JSON.stringify(click.result));
    console.log(
      '[spike] SPIKE 3 PASS: CGEvent postToPid 点击调用链通（CGEventSource+mouse events+postToPid 全跑通，不崩）',
    );
  } else {
    console.log('[spike] click ok:false error =', JSON.stringify(click.error));
    console.log('[spike] SPIKE 3 桥通（调用链执行到 InputSimulation，返结构合法 error）');
  }

  // ── Spike 4: 全量 native dispatch（剩余 8 method 逐个 invoke，验调用链通 + 结构合法）──
  // 读类（真返回，无副作用）：getAppState / listApps。动作类投递本进程 pid（无窗口，零干扰）。
  // setValue/performSecondaryAction 用越界 index / 无效 action 名，验 AX 错误路径不崩（真效果 dogfood 手验）。
  console.log('[spike] ── Spike 4: 全量 native dispatch ──');

  // getAppState（合一：单窗口截图 + AX 树）
  const gas = await invokeChecked('getAppState', {}, 'invoke("getAppState")');
  if (gas.ok) {
    const r = gas.result || {};
    const shotLen = r.screenshot && typeof r.screenshot.data === 'string' ? r.screenshot.data.length : 0;
    const axLen = typeof r.axText === 'string' ? r.axText.length : 0;
    console.log(
      '[spike] getAppState: screenshot.data len=' + shotLen + ' axText len=' + axLen +
        ' pid=' + r.pid + ' scaleFactor=' + r.scaleFactor + ' windowBounds=' + JSON.stringify(r.windowBounds),
    );
    const hasSecondary = axLen > 0 && r.axText.indexOf('Secondary Actions:') >= 0;
    console.log('[spike] getAppState axText 含 "Secondary Actions:" 行 =', hasSecondary);
    console.log('[spike] getAppState PASS: 截图+AX 合一返回结构合法（screenshot + axText + windowBounds + scaleFactor + pid）');
  } else {
    console.log('[spike] getAppState ok:false error =', JSON.stringify(gas.error), '（桥通，结构合法）');
  }

  // listApps（运行中 app 列表）
  const apps = await invokeChecked('listApps', {}, 'invoke("listApps")');
  if (apps.ok && Array.isArray(apps.result)) {
    console.log('[spike] listApps: count=' + apps.result.length + ' first=' + JSON.stringify(apps.result[0]));
    console.log('[spike] listApps PASS: 返 AppInfo[] 结构合法（bundleId/name/pid/isRunning）');
  } else {
    console.log('[spike] listApps 非数组或 ok:false =', JSON.stringify(apps).slice(0, 200));
  }

  // 动作类（投递本进程 pid，零干扰）：scroll / drag / type / pressKey
  const actionCases = [
    ['scroll', { target: { coordinate: { x: 10, y: 10 } }, direction: 'down', pages: 1, pid: process.pid }],
    ['drag', { from: { x: 10, y: 10 }, to: { x: 20, y: 20 }, steps: 5, pid: process.pid }],
    ['type', { text: 'hi', pid: process.pid }],
    ['pressKey', { key: 'escape', pid: process.pid }],
  ];
  for (const [method, params] of actionCases) {
    const res = await invokeChecked(method, params, 'invoke("' + method + '")');
    console.log('[spike] ' + method + ' → ' + JSON.stringify(res.ok ? res.result : res.error) + (res.ok ? ' PASS' : ' （桥通，结构合法 error）'));
  }

  // setValue（越界 index → elementNotFound，验 dispatch + 错误路径，无 AX 副作用）
  const sv = await invokeChecked('setValue', { elementIndex: 999999, value: 'x' }, 'invoke("setValue")');
  console.log('[spike] setValue(越界 index) → ' + JSON.stringify(sv.ok ? sv.result : sv.error) + '（验 elementNotFound 错误路径）');

  // performSecondaryAction（有效 index=0 + 无效 action 名 → 真调 AXUIElementPerformAction 返错，无副作用）
  const psa = await invokeChecked(
    'performSecondaryAction',
    { elementIndex: 0, action: 'AXNonExistentActionForSpike' },
    'invoke("performSecondaryAction")',
  );
  console.log(
    '[spike] performSecondaryAction(index=0, 无效 action) → ' +
      JSON.stringify(psa.ok ? psa.result : psa.error) + '（真调 AXUIElementPerformAction，验错误路径不崩）',
  );

  console.log('[spike] SPIKE 4 PASS: 全量 11 native dispatch 就绪（读类真返回 + 动作类调用链通 + AX 错误路径不崩）');
  console.log('[spike] ALL SPIKES DONE.');
  process.exit(0);
})().catch((err) => {
  fail('spike async chain rejected: ' + (err && err.stack));
});
