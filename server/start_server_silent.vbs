' ============================================================
' Jellyfin PotPlayer 本地服务器 - 静默启动脚本（扩展目录版）
' 自动获取脚本所在目录，支持相对路径
' ============================================================
Set WshShell = CreateObject("WScript.Shell")
' 使用 FileSystemObject 获取脚本所在文件夹，动态拼接 exe 路径
' 参数 0 表示隐藏窗口，False 表示不等待
WshShell.Run """" & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\player_server.exe""", 0, False