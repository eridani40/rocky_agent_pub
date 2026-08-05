# component-market-detail-modal

> 层级: component
> 文件: app/web/src/components/skill-page/component-market-detail-modal.tsx
> 市场 skill 详情 modal（区别于本地 `component-skill-preview-modal`）。

## 职责
市场 skill 详情弹窗。挂载调 `GET /skills/market/detail?ref=` 取详情。展示：头（icon-box + name + ref + 已安装 badge）+ readme+ 包含文件列表（files[].path）+ 底部**状态区**操作（安装 / 检查更新 / 更新 / 已是最新）。
边界：不管本地已安装 skill 的文件树预览（那是 `component-skill-preview-modal`）；可更新判定在本 modal 内惰性完成（比对 detail.hash 与已安装 skill 的 installedHash）；安装/更新动作调 api 后透传 onInstalled 给父。
## Props
- itemRef: string;                      // 市场 item.ref（打开时传入）。**用 `itemRef` 非 `...
- installedSkill?: SkillEntry;          // 若该 ref 已安装（父按 marketRef 匹配后传入；含 inst...
- onClose: () => void
- onInstalled: () => void;              // 安装/更新成功回调（父 refresh）

## 状态 / 交互
- ：安装/更新处理期。
- 状态区渲染依据（互斥，PRD §4）：未安装→「安装」；已安装+updatable null→「检查更新」；updatable true→「更新」+可更新 badge；updatable false→「已是最新」。
- 点 overlay / close → onClose。

## 复用关系
- 被组合：`section-skill-market`
- 组合：icon-box、badge、markdown 渲染（复用现有 chat/preview 的 markdown 能力或简单渲染，coder 定）；图标
- **layout**：overlay  `rgba(24,24,27,0.32)` 居中。modal `width 72
- **font**：name 18px/700；ref 行 13px `var(--muted)` + mono 仓库地址；readme
- **border**：modal `radius-2xl`；head/foot 分隔 `1px var(--border)`；readme code `ra
