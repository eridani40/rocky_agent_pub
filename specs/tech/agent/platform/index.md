---
type: index
title: Platform 子系统总起（OS 原生能力抽象）
priority: P0
updated: 2026-07-16
---

# Platform 子系统总起（OS 原生能力抽象）

## ① 是什么

platform = agent 跨 OS 原生能力的**抽象层**——把「看屏幕 + 操作键鼠 + 探测系统状态」这类**必须调原生 API**（Web 容器外）的能力封装成 TS 接口，让上层工具（tools）只见协议、不感知 OS。

> 与 `tools/browser/`（chrome 自动化，走 CDP/MCP）正交：browser 控制单个 chrome 进程内；computer 控制整个桌面（跨所有 app + 系统 UI）。

| 核心概念 | 一句话 |
|---|---|
| **ComputerNativePort** | 纯 TS 接口（server 零 electron），11 能力：checkPermissions/screenshot/getAppState/readAxTree/listApps + click/type/scroll/pressKey/drag/setValue/performSecondaryAction；方法 ok=false 返 reason 不抛 |
| **native addon** | macOS 实现：主进程加载的 Swift dylib + N-API（`app/computer-native/`），继承 Rocky 主进程 TCC 身份；ScreenCaptureKit 单窗口截图 + AXUIElement + CGEvent postToPid |
| **三态注入 precedence** | AT mock（fixture）/ dev loopback（127.0.0.1 通道）/ packaged registry 直调；bootstrap 单选，两处 deps 组装点注入 ctx.config |
| **权限门禁形状** | port.checkPermissions 返 {accessibility,screenRecording} 两态；主进程 impl 走 electron systemPreferences，tool 门禁消费 |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| ComputerNativePort 接口 + 数据形状 + 主进程 native addon 实现 + 三态注入 precedence | 工具协议（单 computer tool / 11 action dispatch / 门禁）→ `../tools/[P1]computer_use_tool.md` |
| 坐标换算（window-relative 三段式）+ image block 包装契约（产物形态） | ImageBlock 协议原语（union + wire encode）→ `../message/[P0]agent_message_interface.md §4.2` |
| dev loopback 通道（127.0.0.1 + token）+ native addon 编译链 | connector UI（testid/权限两行/引导按钮）→ `specs/ui/overall/05-connectors.md` |
| listApps 输出（v0.0.160 起 = 运行中 + Spotlight recent 合并） | HITL 审批 / TOOL_POLICY bound → `../tools/[P0]tool_policy.md` |

## ③ 与系统的关系

```
   platform KB                        ┌── tools/computer-use/computer.ts  (单 computer tool：dispatch + 门禁 + 坐标换算)
   (本目录)   ─────────────────────────┼── app/electron/computer-native-port.ts  (主进程 impl，调 native addon)
                                      ├── app/computer-native/  (Swift dylib + N-API addon)
                                      ├── message/[P0]agent_message_interface.md §4.2  (ImageBlock 全链路)
                                      └── llm/protocol-encode.ts     (image block encode)
```

**对外协作点**：
- server 侧 = `app/server/src/platform/computer/{native-port.ts, native-port-types.ts, native-port-registry.ts, mock-native-port.ts, loopback-native-port.ts, coords.ts}`（纯 TS，零 electron）
- 主进程 impl = `app/electron/src/{computer-native-port.ts, computer-native-addon.ts, computer-loopback-server.ts}` + native addon `app/computer-native/`
- 注入 seam = `@app/server` 导出 `setComputerNativePort`；main.ts packaged 分支直注入，dev 分支起 loopback server

## ④ 核心设计原则（跨文件不变量）

1. **原生能力必须在主进程内（TCC 铁律）**——macOS 原生能力（截图/AX/键鼠/权限）必须在 Rocky Electron 主进程实现（`com.rocky.agent` = TCC 权限主体）。native addon 是主进程加载的 Swift dylib（`.node`），**继承主进程 TCC 身份**。**绝不 spawn 独立 helper 二进制**（裸 spawn 子进程拿不到 TCC 授权，真机实测 4+ 次；memory `macos-tcc-spawn-no-perm-use-electron-host`）。
2. **server 零 electron**——`ComputerNativePort` 是纯 TS interface；server 只调 port，绝不 import electron / 绝不 spawn。port 的电子实现（native addon 调用）在 `app/electron`。
3. **去连接器语义**——computer 是本机主进程常驻能力，无 toggle / owner 锁 / connect-disconnect / session 生命周期（不像 browser 连外部 CDP）。port 接口 **MUST NOT** 声明 connect/session/disconnect。
4. **三态注入 precedence + 两处 deps 组装点**——bootstrap 单选 `mock ?? loopback ?? registry`；port 经 `router.sessionDeps → session-config` **与** `bootstrap.setResolveConfig 闭包` 两处注入 ctx.config，漏一处 tool 运行时读不到（BUG-001 教训 `session-config-two-deps-assembly-points`）。
5. **fail-closed 全链路**——port 方法 ok=false 返 reason 不抛；addon 缺失/加载失败 → 各方法返 `{ok:false}`/空数组；权限非 granted 一律 missing（`coercePermissions`）；port undefined（非桌面 App）→ tool 返「仅桌面 App 可用」。UT/AT 注入 mock port（守 `test-no-real-spawn-system-gui`）。
6. **postToPid 后台键鼠**——CGEvent.postToPid 定向投递（不抢前台、不移动用户真实硬件光标、**不需 Input Monitoring**）。权限只要 Accessibility（AX + 键鼠）+ Screen Recording（截图）两类。
7. **window-relative 三段式坐标**——element_index（主，AX 语义定位，零像素数学）/ coordinate（辅，`pixel/scaleFactor + windowBounds.origin` 换算）。screenshot/get_app_state 返 windowBounds → tool 按 sessionId 缓存坐标上下文；coordinate 动作前必先 screenshot/get_app_state。
8. **native ScreenCaptureKit 单窗口截图**——screenshot/getAppState 走 addon 的 SCScreenshotManager 单窗口（非 Electron desktopCapturer 全屏）——单一 window-relative 坐标模型不容两套截图坐标空间。

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| `computer_native_capability.md` | ComputerNativePort 接口 + 数据形状 + 主进程 native addon 实现 + 三态注入 precedence + dev loopback 通道 + 坐标换算 | P1 | [link]([P1]computer_native_capability.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
