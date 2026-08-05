# playground-model-switch — 应用设置切换模型后 Playground 生效

> 纯自然语言 case。executor 照 case + app-guide 操作，每步留证，自由心证。

## Use Case
作为用户，我想验证在应用设置里切换 LLM provider/模型后，回 Playground 发消息用的是新模型——配置链路 + Playground 调用链冒烟。

## 前置条件
- env.sh 已起好环境。
- 至少 2 个可用的 LLM provider/model 配置（executor 在应用设置界面看可用列表选，不预定义模型名）。

## 操作目标（编号步骤）

1. **进应用设置**：照 `specs/ui/overall/00-app-guide.md` §3.3——从 nav-rail 底部点「应用设置」入口，落到合并页。
2. **找到模型配置 tab**：在三 tab（app config / dev config / 插件）里找模型相关配置项（provider / 模型默认值）。
3. **查看当前默认模型**：记录当前选中的 provider/model（executor 现场观察，记下名字）。
4. **切换到另一个可用模型**：从可用列表里选一个不同的 provider/model 保存（或设为默认）。
5. **回 Playground**：点 nav-rail Playground 入口。
6. **建/选会话**：新建一个会话（避免历史消息干扰）。
7. **发消息验证新模型生效**：发一条简单消息（如「介绍一下你自己」），等 LLM 回复。
8. **对比风格差异**：观察回复——若新模型的风格/语气/自我介绍明显与切前不同，即可认为新模型生效（executor 自由心证，不强求精确）。

## 验收口径
- **pass**：切换模型成功保存 + 回 Playground 发消息能收到回复（链路通），且回复能体现新模型特征（风格差异或回复正常无异常）。
- **small**：主链路走通但切换体验有小瑕疵（如切换后需手动刷新、UI 状态延迟）。
- **blocking**：模型切换保存失败 / 切换后 Playground 发不出消息 / 回复明显是旧模型（与切换前的相同风格且模型自身介绍矛盾）/ 关键 UI 缺失。

## 依赖
- specs/ui/overall/00-app-guide.md §3.3（应用设置-模型）
- specs/ui/overall/00-app-guide.md §3.1（Playground）
- specs/ui/components/ 对应板块组件 spec
- 环境内可用的 provider/model 配置（executor 现场观察，不预定义）
