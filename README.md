# Jellyfin External Player - PotPlayer Chrome 扩展

在 Jellyfin Web 界面中添加 **用 PotPlayer 播放** 按钮，实现本地播放器直接打开视频。

## ✨ 功能特性

- 🎬 一键调用 PotPlayer 播放 Jellyfin 视频
- 💾 自动恢复上次观看进度
- 📊 实时进度条显示（播放位置/总时长）
- 🔗 NAS 路径映射，支持 SMB 本地盘符直接播放
- 🌐 HTTP 代理模式备用方案
- 🔔 系统托盘后台运行，右键可退出

## 📦 安装方式

### 1. 下载

从 [Releases](https://github.com/justwei001/jellyfin-potplayer-extension/releases) 下载最新 ZIP 包。

### 2. 安装 Chrome 扩展

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择解压后的文件夹

### 3. 配置扩展

1. 点击浏览器工具栏的扩展图标
2. 填写 PotPlayer 路径（如 `C:\Program Files\PotPlayer\PotPlayerMini64.exe`）
3. （可选）配置 NAS 路径映射：
   - **NAS 路径前缀**：Jellyfin 中显示的路径，如 `/volume1/video/`
   - **本地路径前缀**：映射的本地盘符，如 `Z:\`
4. 点击 **保存设置**

### 4. 启动本地服务器

1. 进入解压目录下的 `server` 文件夹
2. 双击运行 `start_server.bat`（带窗口）或 `start_server_silent.vbs`（静默）
3. 首次运行请允许 Windows 防火墙放行
4. 托盘区会出现图标，表示运行成功

## 🚀 使用方法

1. 打开 Jellyfin Web 界面
2. 进入任意视频详情页
3. 点击播放按钮旁的 ▶️ PotPlayer 图标
4. 视频将在 PotPlayer 中开始播放

> ⚠️ **注意**：每次打开 Jellyfin 页面前，请确保本地服务器已在运行。

## 📁 项目结构

```
jellyfin-potplayer-extension/
├── manifest.json          # Chrome 扩展配置
├── popup.html             # 设置界面
├── popup.js               # 设置逻辑
├── content.js             # 注入 Jellyfin 页面的脚本
├── README.md              # 说明文档
└── server/                # 本地服务器
    ├── player_server.exe  # 服务器程序
    ├── start_server.bat   # 启动脚本（带窗口）
    └── start_server_silent.vbs  # 静默启动
```

## ⚙️ 配置说明

### PotPlayer 路径（必填）

PotPlayer 安装程序的完整路径，例如：

- `C:\Program Files\PotPlayer\PotPlayerMini64.exe`
- `D:\Tools\PotPlayer\PotPlayerMini64.exe`

### NAS 路径映射（推荐配置）

将 Jellyfin 中的网络路径转换为本地 SMB 共享盘符，实现真正的本地文件播放。

**示例：**

| 设置项 | 填写内容 |
|--------|---------|
| NAS 路径前缀 | `/volume1/video/` |
| 本地路径前缀 | `Z:\` |

**前提条件：**

1. 在 NAS 上开启 SMB 共享服务
2. 将媒体文件夹映射为 Windows 网络驱动器（如 Z:）
3. 确保 Jellyfin 中显示的路径与 NAS 前缀匹配

### HTTP 代理模式（备用）

不配置路径映射时，服务器会通过 Jellyfin API 获取视频流并传递给 PotPlayer。此方式可能受网络带宽影响。

## ❓ 常见问题

### Q: 点击按钮后提示"连接服务器失败"？

A: 请确保 `server/start_server.bat` 已运行，托盘区有图标显示。

### Q: 按钮没有出现在 Jellyfin 页面？

A: 
- 刷新页面重试
- 确认扩展已启用（`chrome://extensions/`）
- 检查是否进入了视频详情页（非列表页）

### Q: PotPlayer 打开后无法播放？

A:
- 检查 PotPlayer 路径是否正确
- 如果使用 NAS 映射，确认网络驱动器已连接
- 查看 `server/server.log` 日志排查具体原因

### Q: 如何停止服务器？

A: 
- 右键托盘区图标 → **退出**
- 或直接关闭命令行窗口（如果使用的是 `start_server.bat`）

## 🛠️ 从源码编译服务器

需要 .NET Framework 4.7.2+ 和 Windows Forms。

```bash
csc /target:winexe /out:player_server.exe player_server.cs
```

## 📄 License

MIT License