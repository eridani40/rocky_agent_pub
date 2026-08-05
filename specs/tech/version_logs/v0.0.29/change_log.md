# v0.0.29 Tech Change Log — Browser attach cdpUrl loopback SSRF 豁免

> version: 1.0 · 2026-06-28
> 范围红线（严守）：**只 browser attach cdpUrl 的 SSRF 门禁语义修正**（BUG-001 修复）。单一 bugfix，无功能新增。
> 权威输入：`reqs/v0.0.29/bug.md` + `states/v0.0.29/bugs/BUG-001-browser-cdp-loopback-ssrf-[fixed].md`。
> 简化流程：coding → code-review → api-verify → doc-modifier（本文件即 doc 同步）。

## 1. 改动摘要

browser 工具 mode=③ attach 的 `cdpUrl` SSRF 门禁**按 loopback 豁免**——本地 attach 本机 chrome（`127.x` / `::1` / `localhost`）不再被当成私网拒绝；非 loopback（远程私网 / 云元数据 / `file://`）仍 fail-closed。

## 2. 根因

`app/server/src/tools/browser/tool.ts:106-115` 旧门禁把 web-fetch 的 blanket `assertSsrfSafe`（IP 私网黑名单 + 协议白名单）直接套到 attach `cdpUrl`，把 `127.0.0.1` 当私网段拒绝——本地 chrome attach 全功能阻断。

**语义边界错位**：SSRF 防护的边界是**页面导航 / web-fetch**，**不含本地 CDP 控制面**。openclaw `cdp-reachability-policy.ts:33` 注释原文：「The browser SSRF policy protects page/network navigation, not ... local CDP control plane. Explicit local loopback CDP profiles should not self-block just because they target 127.0.0.1.」`resolveCdpReachabilityPolicy`：`cdpIsLoopback && !isRemote → return undefined`（不做 SSRF）。

**附带事实**：attach 模式 input 的 cdpUrl 实际未被消费（`tool.ts:124-131` 走 `connectorManager.getAttachSession('browser')`），门禁先于 mode 判断开火——拦了一个没被使用的值。

## 3. 修复文件清单

| 文件 | 角色 | 变更 |
|------|------|------|
| `app/server/src/tools/web-fetch/ssrf.ts` | SSRF 公共底座 | 新增导出 `isLoopbackIp(ip)` / `isLoopbackHost(url)`：127/8 + ::1 + hostname=localhost；**纯字面量比对，不 DNS 解析**（防 DNS rebinding 把公网域名解析到 127/8 绕过）。不含 `0.0.0.0`。 |
| `app/server/src/tools/browser/tool.ts` | browser 工具入口 | `:106-115` 门禁改为 `isLoopbackHost(cdpUrl)` → 跳过 SSRF（loopback CDP 豁免）；否则 `await assertSsrfSafe(cdpUrl)`（非 loopback 远程/私网/file:// 仍 fail-closed）。 |
| `app/server/src/tools/browser/browser-tool.test.ts` | UT | `:221` 附近：`cdpUrl=127.0.0.1` 翻转为**放行**；保留 `10.x` / `192.168.x` / `file://` 拦截；新增 `169.254.169.254`（云元数据）拦截 + `::1` / `localhost` 放行。 |
| `tests/api/web_fetch/br_attach_ssrf_tc1/` | AT 用例库（反哺） | 反哺真服务用例：`127.0.0.1` / `::1` / `localhost` 放行，`10.x` / `192.168.x` / `169.254.169.254` / `file://` 拦截。 |

## 4. 安全语义（修正后）

| cdpUrl 形态 | 门禁结果 | 依据 |
|---|---|---|
| `http://127.0.0.1:9222` / `http://localhost:9222` / `http://[::1]:9222` | **豁免**（不做 SSRF） | loopback CDP 控制面 ≠ 页面导航 SSRF |
| `http://10.0.0.5:9222` / `192.168.x` / `172.16-31.x` | fail-closed | 远程私网 |
| `http://169.254.169.254/...` | fail-closed | link-local 云元数据 |
| `file:///etc/passwd` | fail-closed | 协议白名单 |

保留 `specs/tech/agent/tools/[P1]browser_tool.md` §5 远程防护语义；仅豁免本地 loopback CDP 控制面。

## 5. 验证结论

- **UT**：browser-tool.test.ts 50/50 pass；全量 2625 回归绿（v0.0.28 基线 2614，新增 11 用例覆盖 loopback/非 loopback 矩阵）。
- **AT（真服务）**：`br_attach_ssrf_tc1` 反哺 `tests/`，覆盖 loopback 放行 + 非 loopback 拦截全分支。
- **无 regression**：v0.0.23.1 的 mode①② NodeWorkerDriver 路径不受影响（attach 独立门禁）。

## 6. 关联 BUG

| BUG | 状态 | 说明 |
|-----|------|------|
| **BUG-001** | fixed | browser attach cdpUrl loopback 被 SSRF 误拦截（本版主修） |
| **BUG-002** | open（follow-up） | SSRF：IPv4-mapped IPv6 hex 形式绕过 `isPrivateIp` 私网检查（pre-existing，v0.0.29 code-review 发现，deferred 不阻塞） |

**BUG-002 不修理由**：(1) 是 pre-existing 公共底座缺陷（`isPrivateIp` regex `::ffff:([0-9.]+)$` 只认 IPv4-mapped 点分形，URL 规范化后的 hex 压缩形 `::ffff:a00:5` 不匹配），非 v0.0.29 引入；(2) 新 `isLoopbackIp` 的同款 gap **零安全影响**（loopback 经点分/ hex 殊途同归到「放行」，行为碰巧一致）；(3) 根因修（统一 IPv6 normalize helper / 引入 `ipaddr.js`）触及 web-fetch 全链路公共底座，需独立聚焦 + 跨用例测试，不宜塞进 BUG-001 安全门禁 diff。

## 7. 范围外（明确不做）

- **attach input cdpUrl 仍 vestigial**：tool.ts 的 inputSchema 接收 cdpUrl，但实际未驱动真实连接（mode③ 走 `connectorManager.getAttachSession('browser')` 取连接器持有的 session）。接入真实连接器（让 cdpUrl 真正 spawn chrome）是单独架构 feature，本版不动。
- **tool.ts inputSchema 的 cdpUrl description 字符串**（`:90`）仍写「远程私网 SSRF fail-closed」——代码侧文案待后续修正；本版 spec 已反映 loopback 豁免语义。
- **BUG-002 IPv6 normalize 根因修**：见上 §6。

## 8. 同步的 overall 文档

| 文件 | 变更 |
|------|------|
| `specs/tech/agent/tools/[P1]browser_tool.md` | version 1.2 → 1.3：§5 安全重写为两层语义（loopback 豁免 + 非 loopback fail-closed）；§8 决策表「远程 chrome attach」条补 v0.0.29 loopback 豁免注；§12 版本段追加 1.3 `[v0.0.29 modified]`。 |
| `specs/api/overall/08-web-tools.md` | §4.1 字段表 `cdpUrl` 说明 + §4.3 isError 分支同步 loopback 豁免语义。 |

## 9. 版本

version: 1.0 `[v0.0.29]`（首版 v0.0.29 tech change_log：单一 bugfix——browser attach cdpUrl SSRF 门禁按 loopback 豁免修 BUG-001；2 实现 + 1 UT + 1 AT 反哺；UT 50/50 + 全量 2625 回归绿；关联 BUG-002 follow-up open；范围外：attach cdpUrl 仍 vestigial + BUG-002 IPv6 normalize）。
