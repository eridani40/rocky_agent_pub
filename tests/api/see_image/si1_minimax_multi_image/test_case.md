# si1_minimax_multi_image — SI-1 主路径（see_image · minimax_m3 · 多图有序）

## 覆盖契约

- **API spec**：`specs/api/overall/08a-see-image-tool.md`
  - §2.1 `ToolDefinition`（`name=see_image`，`inputSchema.required=[text,imagePaths]`）
  - §2.2 输出 `ToolResultBlock` 正常分支（`isError:false`，`content[0].text` = markdown
    `## Understanding (provider: <id>, count: <n>, took: <ms>ms)` + 文字理解正文，untrusted 包装）
  - §3 `app_config.see_image` group（`{type, credentials}`，`GET/PUT /config/app?group=see_image`）
  - §5 AT 覆盖映射（SI-1 → 本 case）
- **PRD 路径**：`specs/prd/version_logs/v0.0.141.see_img/change_log.md` §3 `SI-1`
  （配 key → @ 多图有序提问 → `see_image` → vender 文字理解 → LLM 基于结果回复）
- **tech spec**（字段权威，仅用于确认 SSE/transcript 字段名，不读产品代码）：
  `specs/tech/agent/message/[P0]agent_message_interface.md` §4.6/§4.7（ToolCallBlock/ToolResultBlock）、
  `specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md` §5.4/§5.5（tool_call_*/tool_result_* SSE 事件）

## 场景

1. `setup`：校验 `app_config.see_image` 已预置 minimax_m3 真实凭证（不在本 case PUT 明文 key，见 case.yaml
   头部 D1；**secret 安全约束见 D4** —— 只断言 `.value.type`，不断言 `apiKey`）→ 建会话（预绑定平台 provider）
   → 植入 2 张真实 PNG fixture 到会话 workspace（见 D2）。
2. `steps`：订阅 `agent_loop` SSE → 发消息（生产路径 `POST /session/:id/messages`）显式要求 LLM 调用
   `see_image({text, imagePaths:["see_image_red.png","see_image_blue.png"]})` → 等 `run_end` →
   断言 transcript 里 tool_call 入参、tool_result 内容、最终 assistant 回复。
3. `teardown`：删除会话。

## 断言面

| 层 | 断言 | 对应契约 |
|----|------|---------|
| SSE | `tool_call_start(toolName=see_image)` 出现 ≥1、`tool_result_end` 出现 ≥1、无 `error` 帧 | agent_event §5.4/§5.5 |
| transcript（tool_call） | `ToolCallBlock.name == "see_image"`；`arguments.imagePaths` 含 `see_image_red.png` 与 `see_image_blue.png`（both，间接验证 2 路径 + 有序传入）——按 `.content[type=tool_call]` 过滤定位，不假设下标（见 D5） | 08a §2.1 |
| transcript（tool_result） | `isError == false`；嵌套 `.content[type=text].text` 含 `"Understanding"` 标记；文本不含 `"data:image"` / `"base64"`（不含 base64 特征，间接验证 base64 硬约束不进出参）——按 `.content[type=tool_result]` 过滤定位，不假设下标（见 D5） | 08a §2.2 硬约束 + PRD §2.1 |
| transcript（final reply） | 最后一条消息 `role == "assistant"` 且 `.content[type=text].text` 存在（非空回复）——不假设下标（见 D5） | PRD SI-1 |
| setup（凭证 seed 校验） | `.value.type == "minimax_m3"`（非 secret，可断言）；`.value.credentials exists`（弱断言，只验键存在不验值/子键） | 08a §3 + **D4 secret 值安全约束（见下）** |

**为何 setup 不断言 `apiKey` 值或子键（D4，secret 安全约束 MANDATORY）**：case.yaml 的 check 结果会落 `last_run/`（随 case 入 git）。断言 secret 值会把真实凭证泄漏到 git 历史；断言 secret 子键存在性也把配置结构暴露给测试工件。**任何 case 断言 secret 值或其子键存在性都是安全风险**——凭证真实有效性由真实调 minimax 时 see_image 出站成功这一事实本身证明（v0.0.190 起真实调 API，真 LLM + 真凭证全链路自证）。

**为何不直接断言颜色识别正确**：SI-1 验证的是「工具调用链路通 + 契约形状对」（isError:false / 纯文字 /
LLM 续答），不断言 vender 对颜色的识别准确度（那是 MiniMax 模型能力，非本工具契约范围）。因此 fixture
只需是**真实可解码的 PNG**（不需要美观或语义丰富），2 张 8x8 纯色图片满足要求。

**为何 transcript check 用 `.content[type=X]` 过滤而非 `.content[0]` 下标（D5，2026-07-14 首跑实测踩中）**：
早前版本假设 tool_call/tool_result/最终回复文本都是各自消息 `content` 数组的第一个 block。实测 LLM 常在
调用 `see_image` 前先输出一句文本（`content=[text, tool_call]`），或最终回复前带 `reasoning` block，导致
`.content[0]` 假设 flaky fail。改用 `eval_path` 支持的
`[key=val]` 过滤 token（在数组里按字段值查找元素，不是数组谓词、不受 DSL 嵌套谓词限制）：
`.content[type=tool_call]` / `.content[type=tool_result]` / `.content[type=text]`——与元素实际位置无关，
语义等价（"存在一个 type 匹配的 block 且满足后续断言"）但对真实 LLM 输出顺序鲁棒。已用合成 transcript
（text 在 tool_call 前、reasoning 在最终 text 前）验证：新写法全绿，旧 `.content[0]` 写法在同样输入下会
fail——这是通用陷阱，供其他 case 设计参照。

## fixture

`fixtures/see_image_red.png` + `fixtures/see_image_blue.png`：8x8 RGB 纯色 PNG（74 字节各），python
`zlib`/`struct` 手工编码生成（无第三方依赖），已用 PIL 解码验证有效性。`case.yaml` 内联的 base64 与这两个
文件字节一致（`base64 <fixtures/see_image_red.png` 可核对）。

## 依赖 / 已知假设（MANDATORY 对照）

**更新（v0.0.190 真实调 API）**：D1 凭证预置已由 env_start.sh `cp -rL` dev see_image config 替代（test env self-contained，含真实 minimax_m3 key）；D2 fixture 写盘照旧（files 原语支持 `encoding: base64`）；D4 由「replay 脱敏」改为「secret 值安全约束」（check 结果会入 git）。以下为完整依赖清单：

1. **D1 凭证预置**（v0.0.190 已改为 dev config copy）：`app_config.see_image` 真实 minimax_m3 key 由 `env_start.sh` 从 dev 拷贝到 test DATA_DIR（`cp -rL` 解引用 symlink，test env self-contained）。本 case 不写死 key，只在 setup GET 校验（**校验断言须遵守 D4 secret 安全约束**，不可断言 secret 值/子键）。
2. **D2 二进制 fixture 写盘**：`files` DSL 原语已扩展支持 `encoding: base64`（比照
   multipart file 字段既有约定），写入 `workspaces/{sid}/*.png`（= 会话缺省 workspaceDir）。
3. **D3 timeout**：`wait` 单步上限 60s，tool 层 `defaultTimeoutMs=90000`。真实调 minimax 通常 10-20s 完成；
   若超时按陷阱清单 #11 拆分接力等待（poll 替代长 wait）。
4. **D4 secret 值安全约束（通用规则，MANDATORY——已修复本 case，供其他 case 设计参照）**：case.yaml 的
   check 结果会落 `last_run/`（随 case 入 git）。**任何 case 断言 secret 值或其子键存在性都是安全风险**——
   校验凭证 seed 生效只能断言非 secret 的伴随字段（如 `type`）+ secret 键本身存在（不论值/子键）。
   凭证真实有效性由真实调 minimax 时 see_image 出站成功这一事实本身证明。
5. **D5 transcript check 不依赖 content block 下标（通用规则，MANDATORY——已修复本 case，供其他 case
   设计参照）**：不假设 tool_call/tool_result/最终回复文本是各自消息 `content` 数组的第一个 block——
   LLM 常在工具调用前先输出文本、最终回复前带 reasoning block，`.content[0]` 假设 flaky。改用
   `.content[type=X]` 过滤 token 按字段值定位（非数组谓词，不受嵌套谓词限制），语义等价
   但对真实 LLM 输出顺序鲁棒。详见「为何 transcript check 用 `.content[type=X]` 过滤」段。
