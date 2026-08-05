# electron-builder 资源目录

> 引入版本: v0.0.11 — Rocky 品牌图标资产
> 来源: `reqs/v0.0.11/icon.png`（358×358 RGBA）
> 参考: `specs/ui/components/chat-page/brand-rocky.md` §3

## 资产清单

| 文件 | 用途 | 尺寸 | 生成方式 |
|------|------|------|----------|
| `icon.icns` | macOS app 图标（dmg/Dock/窗口） | 含 16~1024 全尺寸 | `iconutil -c icns`（mac 自带） |
| `icon.png` | Linux 默认图标 / electron-builder 兜底 | 512×512 | `sips -z 512 512` |
| `icon-{16,32,48,64,128,256,512,1024}.png` | 多尺寸 png（备用 / 自定义 window icon） | 各尺寸 | `sips -z <sz> <sz>` |

## electron-builder 配置引用

- `mac.icon`: `buildResources/icon.icns`
- `win.icon`: `buildResources/icon-256.png`（占位，见下方 TODO）
- linux / 兜底: electron-builder 自动从 `buildResources/icon.png` (512×512) 读取

## 重新生成（源图变更后）

```bash
SRC=../../reqs/v0.0.11/icon.png  # 调整为当前 worktree 的源图路径
ICONSET=rocky.iconset
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for spec in "16:16@1x" "32:16@2x" "32:32@1x" "64:32@2x" "128:128@1x" \
            "256:128@2x" "256:256@1x" "512:256@2x" "512:512@1x" "1024:512@2x"; do
  sz="${spec%%:*}"; name="${spec#*:}"
  sips -z "$sz" "$sz" "$SRC" --out "$ICONSET/icon_${name}.png"
done
iconutil -c icns -o icon.icns "$ICONSET"
rm -rf "$ICONSET"
for sz in 16 32 48 64 128 256 512 1024; do
  sips -z "$sz" "$sz" "$SRC" --out "icon-${sz}.png"
done
cp icon-512.png icon.png
```

## TODO（v0.0.11 已知缺口）

### Windows .ico 生成工具链缺失

本仓库当前**无** png→ico 转换工具（未安装 imagemagick / icoutils / electron-icon-builder）。

- **影响**：在 mac 主机本地 `electron-builder` 实际只构建 mac dmg（`build-dmg.sh`），win nsis 包不构建，
  故 `.ico` 缺失**不破当前 build**。
- **占位方案**：`electron-builder.yml` 的 `win.icon` 暂指向 `buildResources/icon-256.png`（256×256 png）。
- **真正跨平台发版前必须补**：
  - 方案 A（推荐）：`bun add -D electron-icon-builder`，配 `package.json` 脚本一键生成全套 icns/ico/png。
  - 方案 B：`brew install imagemagick`，用 `convert icon-256.png -define icon:auto-resize=16,32,48,64,128,256 icon.ico`。
  - 方案 C：在线工具（如 icoConvert）手工导出 `icon.ico` 放入本目录。

补齐后：把 `electron-builder.yml` 的 `win.icon` 改回 `buildResources/icon.ico`，删除此 TODO。
