# playground-academy-smoke — Academy 板块主路径冒烟

> 照 `playground-send-message/case.md` 样例模板写（纯自然语言，零断言零录制零 testid 预定义）。
> executor 读 case.md + app-guide + 12-academy.md，按 snapshot 可见文案/位置自选定位方式，自由心证。
> 覆盖 `reqs/[working] v0.0.210.new_academy/design.md` §8 关键产品 case a-d（板块最小贯通链路）。

## Use Case
作为 Rocky 的个人用户，我想在 Academy 板块走通核心链路——创建教室（自动建班主任）→ 创建学生 → 编辑初始版本 → 发起一次简单训练 → 看结果，验证新板块主路径贯通的最小冒烟。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式），独立 DATA_DIR（首次进入应为空态，无教室）。
- LLM provider 可用（minimax 优先；executor 看 app 内可用 provider 选）。简单训练会真调 LLM。

## 操作目标（编号步骤）

1. **进入 Academy 板块**：照 `specs/ui/overall/00-app-guide.md` §2——nav-rail 顶部业务区第 3 个入口「Academy」🎓，落到 academy 页。空态时应看到主区 hero（「选一间教室开始，或新建一间」类文案）+ 左侧 academy sidebar（「+ 新建教室」按钮 + 教室列表 + 底部训练资源分组）。参考 §3.3 与 `12-academy.md` §2。

2. **创建教室（自动建班主任）**：点 sidebar「+ 新建教室」，起一个名字（如「冒烟教室」）创建成功 → 落教室详情页（`12-academy.md` §3）：左侧出现**班主任对话区**（「班主任 · ● 在线 · 随时可聊」类文案 + 消息流 + 输入框，说明 head session 已自动建好），右侧 tab 栏可见「学生 / 训练任务 / 数据集 / 评估器」。**（可选）**跟班主任说一句简单问候，确认能收到回复（验证 head 可对话，非只读）。

3. **创建学生（自动建 0.0 初始版本）**：在「学生」tab 点「+ 添加学生」（或学生网格末位的虚线卡），填名字创建 → 学生卡片出现在网格里 → 点学生卡进**学生详情页**（`12-academy.md` §4）：左侧版本树可见「0.0 初始版本」（正式版徽章），右侧版本 hero + 五元组卡片（System Prompt / Skills / Memory / Tools / 模型）。

4. **编辑初始版本（五元组，统一 md 弹层）**：在学生详情页点版本 hero 的「✏️ 编辑版本」（或五元组卡头的「查看 / 编辑」）→ 弹出统一 md 编辑弹层（`12-academy.md` §8：文件名 + 「👁 查看 / ✏️ 编辑」二段切换）→ 切到编辑模式，对 AGENTS.md（System Prompt）做一处简单修改（如加一句「你是一个乐于助人的文案助手」）→ 保存成功、弹层可关闭、版本号不变（底部 hint 语义）。

5. **发起简单训练（简单模式单轮）**：学生详情页顶部操作行点「＋ 发起训练」→ 训练发起弹层（`12-academy.md` §9）：**选「简单」模式卡**（单轮学习，无需数据集/评估器——本 case 不建数据集/评估器，多轮卡应为不可用态，executor 可顺带观察但不断言）→ 在「训练目标」textarea 填一条简单 directive（如「学一下怎么写更亲切的问候语」）→ 点「发起训练 →」→ 创建训练任务 + 自动起专属 coach session → 自动跳到**训练观察页**。

6. **看训练观察页 + 结果**：训练观察页（`12-academy.md` §5）——中间是 **coach 对话**（可对话，coach 会报告进度；前端几秒轮询刷新，耐心等），右侧是**训练视图**（4 状态格：任务状态/当前轮次/临时基线/最高分 + 迭代记录）。等待简单训练跑完（单轮，真调 LLM）：任务状态推进到 **paused 终态**（v0.0.221 三态机：paused + pausedReason 如 maxturns/completed/earlystop；旧「待确认/awaiting_confirm」已废），看到训练结果——coach 汇报。**采纳入口在学生详情页版本树过程版行尾的「采纳」按钮**（v0.0.221 采纳是 inline 旁路：无独立结果页、无「拒绝」入口；点过程版「采纳」→ POST adopt → 生成新正式版本 formal x.0，版本树可见）。返回学生详情页点该「采纳」按钮确认可用。LLM 实际回复内容质量不由 executor 判，只判链路通不通、状态推不推、采纳入口在不在。

7. **coach 持续可达（PRD §2.3，v0.0.219 新增覆盖）**：任务进入 **paused 终态**（v0.0.221：paused + pausedReason；旧 done/aborted 已合并为 paused+reason）后，**返回学生详情页**（顶栏「← 学生」返回）——确认学生详情左栏**任务卡仍在**（v0.0.219 渲染门改为最近 N=3 条任务，含终态，每张卡保留「进入观察 →」入口；v0.0.221 paused 任务卡显「续训」按钮 reason≠maxturns / 「调大 maxTurns」入口 reason=maxturns）。点该任务卡的「进入观察 →」回到训练观察页，**coach 列仍可输入对话**（caps 不降级，发一句简单消息能收到回复）。验证「coach 总是可以进去聊几句」+ 训练中页面不 freeze 到结束后才出。

## 验收口径（executor 自由心证）
- **pass**：7 步主路径全部走通——进板块 / 建教室（班主任自动就位）/ 建学生（0.0 版本自动就位）/ md 弹层编辑保存 / 简单训练发起成功并跳观察页 / 训练跑完看到结果与接受/拒绝入口 / 终态后返回学生详情任务卡仍在且可再进观察页与 coach 对话，无瑕疵。
- **small**：走通了但有视觉/文案小瑕疵（如文案微差、布局小错位、偶发 console warning），不影响主路径。
- **blocking**：某步走不下去——Academy 入口找不到 / 建教室或建学生报错 / 班主任对话区缺失 / 编辑弹层打不开或保存失败 / 训练发起不了（报错或一直转圈）/ 观察页关键元素缺失（coach 对话或训练视图不在）/ 训练一直不推进或报错 / **采纳入口（学生详情版本树过程版「采纳」按钮）不出现或点击无新正式版生成** / 任务终态后学生详情任务卡消失或「进入观察」入口丢失 / coach 列在终态任务下不可输入。

## 依赖
- `specs/ui/overall/00-app-guide.md` §2（nav-rail 入口）+ §3.3（Academy 操作路径）
- `specs/ui/overall/12-academy.md` §2（主页布局）/ §3（教室详情）/ §4（学生详情）/ §5（训练观察）/ §8（md 编辑弹层）/ §9（训练发起弹层）——可见文案/布局权威源，executor 按文案自选定位
- `specs/ui/components/academy-page/` 组件 spec（student-card / version-tree / component-modal-md-editor / component-training-create-modal / training-status-bar / iteration-timeline 等）
- `specs/api/overall/18-academy.md`（端点契约；executor 如需 curl 辅助查任务状态可参考）
- `reqs/[working] v0.0.210.new_academy/design.md` §8（关键产品 case a-d = 本 case 覆盖范围）
