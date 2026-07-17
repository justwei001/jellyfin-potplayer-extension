' ============================================================
' Jellyfin PotPlayer 本地服务器 - 静默启动脚本（无控制台窗口）
' 启动后可在 http://localhost:58000 访问
' ============================================================
Set WshShell = CreateObject("WScript.Shell")
' 参数 0 表示隐藏窗口，False 表示不等待进程结束
WshShell.Run """I:\ai\ai-projects\jellyfin-potplayer-host\player_server.exe""", 0, False
