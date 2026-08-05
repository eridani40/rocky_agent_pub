# v0.0.225 change_plan — web_fetch headless 诊断 + chrome-discover glob + jina timeout

## 背景
v0.0.224 修复后 prod baike 仍失败：error.log 显示「headless 渲染失败」但笼统无法定位；另发现 chrome-discover ls glob bug（确凿）+ jina 20s timeout 不够大页。

## 变更契约（8 列）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|---------|------|------|--------|
| web-fetch/local-fetcher | app/server/src/tools/web-fetch/local-fetcher.ts | fetchHeadless 失败归因 | 修改 | headlessRenderer 抛错时把真实 error 透出到 FetchResult.err（含 executeOnce error.message / worker stderr），不再笼统吞；localFail helper 带 err | 不改 headless 触发条件（静态不足才起）；err 经 race-runner onFailure → tool error.log | local-fetcher.ts fetchHeadless ~135-143；v0.0.224 err 字段链路 | local-fetcher.ts |
| browser/chrome-discover | app/server/src/tools/browser/chrome-discover.ts | playwrightChromiumCandidatesMac + Linux | 修改 | 用 readdirSync 列 ms-playwright/chromium-* 目录 + 拼路径 existsSync 验证（替代 execFileSync('ls',[glob])——不经 shell ls 不展开 glob=坏）；保留 deps 注入可 UT | 不改三级 fallback 顺序（用户配置>系统默认>硬编码+playwright）；readdirSync 走 fs（existsSync 注入） | chrome-discover.ts:210-242；实证 execFileSync ls glob 不展开 | chrome-discover.ts ~210-242 |
| web-fetch/jina-fetcher | app/server/src/tools/web-fetch/jina-fetcher.ts | DEFAULT_JINA_TIMEOUT_MS | 修改 | 20_000 → 放宽（对齐或接近 race 总超时 30s，让大页 jina 有机会）；race 总超时 OVERALL_TIMEOUT_MS 同步评估 | race 总超时 30s 是 race-runner 硬上限，jina timeout 不应超过它；改默认值（app_config 缺省回退） | jina-fetcher.ts:24；race-runner.ts OVERALL_TIMEOUT_MS | jina-fetcher.ts:24 |

## UT
- chrome-discover: readdirSync mock（chromium-1228/chrome-mac-arm64/...）→ 断言命中；无 chromium-* → []；保留 ls 旧测改为 readdirSync 形态。
- local-fetcher: headlessRenderer 抛「chrome_not_found: ...」→ err 透出该 message（非笼统）。

## 打包护栏
- 无新依赖；chrome-discover 用 node:fs readdirSync（packaged 可用）。
- packaged 验证：干净环境（env -i）下 executeOnce render 用 playwright chromium（移除系统 Chrome 候选或无系统 Chrome 机器）→ 命中 readdirSync 路径。
