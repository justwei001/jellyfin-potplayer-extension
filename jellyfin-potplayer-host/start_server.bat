@echo off
REM ============================================================
REM Jellyfin PotPlayer 本地服务器 - 启动脚本（带控制台窗口）
REM 启动后可在 http://localhost:58000 访问
REM ============================================================
echo Jellyfin PotPlayer Server (port 58000)
echo.
REM 启动本地服务器（带控制台窗口，方便查看日志和调试）
"I:\ai\ai-projects\jellyfin-potplayer-host\player_server.exe"
if %errorlevel% neq 0 (
    echo Error code: %errorlevel%
    pause
)
