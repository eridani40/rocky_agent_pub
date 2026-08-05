# v0.0.251 change_plan — panorama 归档 task 404（URL path 参数未 decode）

> 纯技术 bugfix（URL decode，不改用户可感知行为/界面）→ 跳 PRD。本 change_plan 为 method 级 review 合同 + 编码前置（MANDATORY）。
> 根因详见 `reqs/[working] v0.0.251/req.md` + `states/v0.0.251/context.md`。

## 根因一句话
`router.ts:45 path = url.pathname` 返回 percent-encoded 形式（不解码）→ `panorama/http/routes.ts` 正则捕获的 entity/id 仍编码 → 非 ASCII id（如 `概括手`→`%E6%A6%82...`）当文件名查 store 找不到 → 404 `panorama_instance_not_found`。与 cron BUG-001（`cron-tool-shared.ts:150`）同模式。

## 变更表（8 列）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|----------|------|---------|------|------|--------|
| panorama/http | app/server/src/squad/panorama/http/routes.ts | `decodeSeg`（新增 helper） | 新增 | `function decodeSeg(s){ try{return decodeURIComponent(s)}catch{return s} }`——容错 decode（非法 `%` 序列返回原值，不阻断；对齐 cron 容错） | 不抛错（malformed 客户端不会发，web 侧正确 encode）；纯函数 | cron-tool-shared.ts:160 `jobMatches` try/catch decode | 文件顶部 helpers 区 |
| panorama/http | app/server/src/squad/panorama/http/routes.ts | `handlePanoramaRoute`（5 处正则下放点） | 修改 | 5 处捕获参数经 `decodeSeg` 后下放：①`createMatch[1]`(entity) ②`transMatch[1]`(entity)+`[2]`(id) ③`oneMatch[1]`(entity)+`[2]`(id) | entity(ASCII 自解)+id(非 ASCII 受益) 都 decode；squadId 不动（ULID ASCII，routes.ts:38）；handler 签名零改 | skill.ts:97 / plugin-scope-handlers.ts:59 / academy-student.ts:76 已 decode 先例 | line 57-68 |
| panorama/http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | — | 不变 | handler 用 decoded id 查 store，零改（decode 在路由边界完成） | — | — | — |
| panorama/store | app/server/src/squad/panorama/store/panorama_store.ts | — | 不变 | `getInstance` 读 `entities/{entity}/{id}.json`，id 已 decoded 即匹配 | — | — | — |
| web | app/web/src/lib/panorama-api.ts | — | 不变 | `patchPanoramaEntity` 已正确 `encodeURIComponent`（line 105），web 侧零改 | — | — | — |
| panorama/test | app/server/src/squad/panorama/__tests__/panorama-routes.test.ts | 新增 describe/it | 新增 | 非 ASCII id 用例：用 id `C4-T1-v4-概括手-r2`（复刻报障 id）create task → GET → PATCH(archived:true 归档) → POST transition，断言全 200 + id decoded 往返 | 复用现有 `req()` helper（line 59-66，已用 `new URL(url).pathname` 对齐 router encoded 路径，直接复现 bug 点）；不新造 helper | panorama-routes.test.ts 现有 ASCII 用例结构 | 文件末尾追加 |

## 不做（范围纪律）
- 不改 `router.ts`（全局 path 不解码是既定设计，cron/skill 等多 handler 已各自 decode 适配；改全局影响面大且无必要）
- 不改 web 侧（已正确 encode）
- 不新增 panorama AT case（持久化用例库铁律：普通 bugfix 不新增；用现有 `tests/api/panorama` ASCII case 跑回归确保不破坏）
- 不动 member/squad/session id 路径（ULID ASCII，不受影响）
- 不加 ET（路由层 decode，UT 精确覆盖，无 UI 变化）

## 测试计划（test-plan）
- **UT（精确覆盖 bug 点，MANDATORY）**：panorama-routes.test.ts 加非 ASCII id 用例（create/GET/PATCH-archive/transition 往返）；全量 `bun run test` 不回归
- **AT（回归，不新增 case）**：`CASES=<现有 panorama case> bash tests/api/lib/run_all.sh` 确保 ASCII 路径不破坏
- 无设计稿 → 视觉保真 compare 跳过

## doc-sync 待办（阶段 5）
- `specs/api/overall/14-panorama-endpoints.md` + `specs/tech/squad/[P1]panorama_http.md`：注明 path 参数（entity/id）经 URL-decode（对齐 cron BUG-001 / skill 等 handler 既定口径）
