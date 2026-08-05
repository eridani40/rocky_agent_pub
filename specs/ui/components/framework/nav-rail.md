# nav-rail

> 层级: framework
> 文件: app/web/src/components/framework/nav-rail/nav-rail.tsx

## 职责
~56px 窄图标栏：**顶部品牌「R」** + **顶部业务区**（Playground 对话图标 + Studio 团队图标）+ **底部独立入口**（SKILLS / 渠道 / 连接器 / 应用设置，自上而下垂直排列，无齿轮子菜单）。
- **底部三独立入口**（自上而下垂直排列，spacer 推底）：
  1. **SKILLS**：独立 nav item，view id `'skill'` 路由到 `page-skill`。tooltip「SKILLS」。
  2. **连接器**：独立 nav item，view id `'connector'` 路由到 `page-connector`。tooltip「连接器」。
  3. **应用设置**：独立 nav item，view id `'settings-app'` 路由到新「应用设置」合并页。tooltip「应用设置」。

## Props
- currentView: string;            // 当前激活 view id（'playground' | 'studio' | 'sk...
- onChange: (view: string) => void; // 点击图标切换

## 状态 / 交互
- 点击任一 nav item（业务区 / 底部三独立入口）→ `onChange(view)`
- hover tooltip： 定位脱离文档流（ 右侧浮出）， 控制显隐，**出现/消失不导致位移**
- 激活态：左侧 3px×20px 竖条（绝对定位 `-left-2`，居中，右侧圆角，仅 active 渲染）+ 底色  + 文字 。竖条绝对定位脱离文档流，切换激活项**不位移**
- brand「R」（E→R）：静态品牌标识，不可点（见 上方 brand 契约）
- **去掉 theme-toggle**：theme 切换移至 AppSettingsPage appearance 区；nav-rail 不再渲染 `nav-theme-toggle` - 栏：宽 56px， + 右 ，，flex column（brand 顶 + 业务区 + spacer + 底部三独立入口）
- brand：34×34 橙色圆角方块 ，白字 Playfair 700 16px，，轻阴影。**文本「R」**（E→R，Rocky）
- **删除** v0.0.33.1 设置组子菜单视觉；底部三独立 NavIcon 与顶部业务区 NavIcon 视觉一致（同 40×40 rounded-lg + active 竖条 + hover tooltip）。
- **tokens.css 清理**：`drawerUp` keyframes 若仅 SettingsGroup 用则可删（非阻塞，coder 判定）。

## 复用关系
- 被组合：`app-shell`
