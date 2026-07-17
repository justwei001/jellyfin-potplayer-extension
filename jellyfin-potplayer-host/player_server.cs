/**
 * Jellyfin PotPlayer 本地 HTTP 服务器
 * ============================================================
 * 在本地 58000 端口启动 HTTP 服务，接收 Chrome 扩展的请求，
 * 启动 PotPlayer 播放视频，并通过 Windows 消息机制控制播放进度，
 * 同时向 Jellyfin 服务端汇报播放状态（开始/进度/停止）。
 *
 * 功能：
 * 1. /play    POST - 接收播放请求，解析文件路径，启动 PotPlayer
 * 2. /status  GET  - 查询当前播放进度
 * 3. /seek    POST - 跳转到指定播放位置
 * 4. /ping    GET  - 健康检查
 *
 * 编译命令：csc player_server.cs -r:System.Windows.Forms.dll -r:System.Drawing.dll
 * ============================================================
 */
using System;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

/// <summary>
/// 主服务器类 - 处理 HTTP 请求、PotPlayer 通信和 Jellyfin 状态汇报
/// </summary>
class PlayerServer
{
    // ==================== Win32 API 声明 ====================
    // 用于查找 PotPlayer 窗口并向其发送控制消息

    /// <summary>查找指定类名/标题的顶层窗口句柄</summary>
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    /// <summary>向指定窗口发送消息（用于控制 PotPlayer）</summary>
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

    // ==================== PotPlayer 自定义消息常量 ====================
    // PotPlayer 通过 Windows 自定义消息（WM_USER + 偏移量）实现外部控制
    const int WM_USER = 0x0400;                  // 自定义消息基址
    const int PPM_GET_TOTAL_TIME = 0x5002;       // 获取总时长（ms）
    const int PPM_SET_CURRENT_TIME = 0x5003;     // 设置播放位置（ms）
    const int PPM_GET_CURRENT_TIME = 0x5004;     // 获取当前播放位置（ms）
    const int PPM_GET_PLAY_STATUS = 0x5006;      // 获取播放状态

    // ==================== 配置与状态 ====================
    static string potplayerPath = "";             // PotPlayer 可执行文件路径
    static string nasPathPrefix = "";             // NAS 路径前缀（远程路径）
    static string localPathPrefix = "";           // 本地路径前缀（映射路径）
    static string logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "server.log");  // 日志文件路径
    static NotifyIcon trayIcon;                   // 系统托盘图标
    static HttpListener listener;                 // HTTP 监听器

    // ==================== 当前播放会话状态 ====================
    static CancellationTokenSource progressCts;   // 进度跟踪线程取消令牌
    static string currentItemId;                  // 当前播放的媒体项 ID
    static string currentServerUrl;               // Jellyfin 服务器地址
    static string currentApiKey;                  // Jellyfin API 密钥
    static string currentUserId;                  // 当前用户 ID
    static string currentPlaySessionId;           // 当前播放会话 ID
    static long currentResumeTicks;               // 上次播放进度（ticks，1 tick = 100ns）
    static long lastPosMs;                        // 最后记录的播放位置（ms）
    static long lastDurMs;                        // 视频总时长（ms）
    static long maxPosMs;                         // 本会话中达到的最大播放位置（ms）
    static bool isPotPlayerRunning;               // PotPlayer 是否正在运行

    /// <summary>
    /// 程序入口 - STAThread 模式以支持系统托盘图标
    /// </summary>
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        InitTrayIcon();   // 初始化系统托盘图标
        InitServer();     // 启动 HTTP 服务器

        Application.Run();  // 进入 Windows 消息循环（保持后台运行）
    }

    /// <summary>
    /// 初始化系统托盘图标及其右键菜单
    /// 提供：查看日志、打开目录、退出 三个功能
    /// </summary>
    static void InitTrayIcon()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("查看日志", null, (s, e) => Process.Start("notepad.exe", logPath));
        menu.Items.Add("打开目录", null, (s, e) => Process.Start("explorer.exe", AppDomain.CurrentDomain.BaseDirectory));
        menu.Items.Add("-");
        menu.Items.Add("退出", null, (s, e) =>
        {
            try { if (listener != null) listener.Stop(); } catch { }
            trayIcon.Visible = false;
            Application.Exit();
        });

        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Jellyfin PotPlayer Server",
            ContextMenuStrip = menu,
            Visible = true
        };
        trayIcon.DoubleClick += (s, e) => Process.Start("notepad.exe", logPath);

        Log("Tray icon initialized");
    }

    /// <summary>
    /// 启动 HTTP 服务器，监听 http://localhost:58000
    /// 在后台线程中处理传入的 HTTP 请求
    /// </summary>
    static void InitServer()
    {
        try
        {
            listener = new HttpListener();
            listener.Prefixes.Add("http://localhost:58000/");
            listener.Start();

            // 后台线程持续处理请求
            new Thread(() =>
            {
                while (true)
                {
                    try
                    {
                        var ctx = listener.GetContext();
                        ProcessRequest(ctx);
                    }
                    catch (Exception e)
                    {
                        if (listener.IsListening) Log("Listener error: " + e.Message);
                    }
                }
            }) { IsBackground = true }.Start();

            Log("Server started on port 58000");
        }
        catch (Exception e)
        {
            Log("Server start failed: " + e.Message);
            MessageBox.Show("Server start failed: " + e.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Application.Exit();
        }
    }

    /// <summary>
    /// HTTP 请求路由处理
    /// 根据请求路径和方法分发给对应的处理逻辑
    /// </summary>
    /// <param name="ctx">HTTP 请求上下文</param>
    static void ProcessRequest(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var resp = ctx.Response;

        // 处理 CORS 预检请求
        if (req.HttpMethod == "OPTIONS")
        {
            resp.AddHeader("Access-Control-Allow-Origin", "*");
            resp.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            resp.AddHeader("Access-Control-Allow-Headers", "Content-Type");
            resp.StatusCode = 204;
            resp.OutputStream.Close();
            return;
        }

        // ==================== /play - 播放请求 ====================
        if (req.Url.AbsolutePath == "/play" && req.HttpMethod == "POST")
        {
            try
            {
                // 解析 JSON 请求体
                var reader = new StreamReader(req.InputStream, Encoding.UTF8);
                var body = reader.ReadToEnd();
                var pp = ParseJsonStr(body, "potplayerPath");
                var itemId = ParseJsonStr(body, "itemId");
                var serverUrl = ParseJsonStr(body, "serverUrl");
                var apiKey = ParseJsonStr(body, "apiKey");
                var userId = ParseJsonStr(body, "userId");
                var nasPrefix = ParseJsonStr(body, "nasPathPrefix");
                var localPrefix = ParseJsonStr(body, "localPathPrefix");

                Log("Request: itemId=" + itemId);
                Log("nasPrefix=[" + nasPrefix + "] localPrefix=[" + localPrefix + "]");

                // 校验 PotPlayer 路径
                if (!string.IsNullOrEmpty(pp) && File.Exists(pp))
                    potplayerPath = pp;
                else
                {
                    WriteJson(resp, "{\"status\":\"error\",\"message\":\"PotPlayer not found\"}");
                    return;
                }

                // 更新路径映射配置
                if (!string.IsNullOrEmpty(nasPrefix))
                    nasPathPrefix = nasPrefix;
                if (!string.IsNullOrEmpty(localPrefix))
                    localPathPrefix = localPrefix;

                // 从 Jellyfin API 获取文件路径（含超时保护）
                var filePath = GetFilePathWithTimeout(serverUrl, itemId, apiKey, userId);
                Log("Jellyfin path: " + filePath);

                // 保存当前会话信息
                currentItemId = itemId;
                currentServerUrl = serverUrl;
                currentApiKey = apiKey;
                currentUserId = userId;

                // 构造跳转参数（断点续播）
                var seekArg = "";
                if (currentResumeTicks > 0)
                {
                    var sec = (int)(currentResumeTicks / 10000000);  // 1 tick = 100ns
                    var h = sec / 3600;
                    var m = (sec % 3600) / 60;
                    var s = sec % 60;
                    seekArg = " /seek=" + h.ToString("D2") + ":" + m.ToString("D2") + ":" + s.ToString("D2");
                    Log("Seek arg: " + seekArg);
                }

                // 策略1: 如果是 Strm 链接（HTTP URL），直接打开
                if (!string.IsNullOrEmpty(filePath))
                {
                    if (filePath.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                        filePath.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                    {
                        Log("Strm/URL detected, opening in PotPlayer: " + filePath);
                        Process.Start(potplayerPath, "/play \"" + filePath + "\"" + seekArg);
                        StartProgressTracker();
                        WriteJson(resp, "{\"status\":\"success\",\"mode\":\"strm\",\"message\":\"Strm 流媒体\"}");
                        return;
                    }

                    // 策略2: 尝试路径映射为本地文件（NAS 映射）
                    var localPath = TranslatePath(filePath);
                    Log("Translated: [" + localPath + "]");

                    if (!string.IsNullOrEmpty(localPath) && File.Exists(localPath))
                    {
                        Log("File found, opening PotPlayer...");
                        Process.Start(potplayerPath, "/play \"" + localPath + "\"" + seekArg);
                        StartProgressTracker();
                        WriteJson(resp, "{\"status\":\"success\",\"mode\":\"file\",\"message\":\"本地文件\"}");
                        return;
                    }

                    if (!string.IsNullOrEmpty(localPath))
                        Log("File not found locally: " + localPath);
                }

                // 策略3: 回退到 Jellyfin HTTP 代理流
                var streamUrl = serverUrl.TrimEnd('/') + "/Videos/" + itemId + "/stream?Static=true&api_key=" + apiKey;
                Log("Fallback stream URL: " + streamUrl);
                Process.Start(potplayerPath, "/play \"" + streamUrl + "\"" + seekArg);
                StartProgressTracker();
                WriteJson(resp, "{\"status\":\"success\",\"mode\":\"stream\",\"message\":\"Jellyfin 代理\"}");
            }
            catch (Exception e)
            {
                Log("Play error: " + e.Message);
                try { WriteJson(resp, "{\"status\":\"error\",\"message\":\"" + EscapeJson(e.Message) + "\"}"); } catch { }
            }
        }
        // ==================== /ping - 健康检查 ====================
        else if (req.Url.AbsolutePath == "/ping" && req.HttpMethod == "GET")
        {
            WriteJson(resp, "{\"status\":\"ok\"}");
        }
        // ==================== /status - 查询播放状态 ====================
        else if (req.Url.AbsolutePath == "/status" && req.HttpMethod == "GET")
        {
            var json = "{" +
                "\"isPlaying\":" + (isPotPlayerRunning ? "true" : "false") + "," +
                "\"positionMs\":" + lastPosMs + "," +
                "\"durationMs\":" + lastDurMs + "," +
                "\"itemId\":\"" + (currentItemId ?? "") + "\"," +
                "\"serverUrl\":\"" + EscapeJson(currentServerUrl ?? "") + "\"," +
                "\"apiKey\":\"" + EscapeJson(currentApiKey ?? "") + "\"," +
                "\"userId\":\"" + EscapeJson(currentUserId ?? "") + "\"" +
                "}";
            WriteJson(resp, json);
        }
        // ==================== /seek - 跳转播放位置 ====================
        else if (req.Url.AbsolutePath == "/seek" && req.HttpMethod == "POST")
        {
            try
            {
                var reader = new StreamReader(req.InputStream, Encoding.UTF8);
                var body = reader.ReadToEnd();
                var posStr = GetJsonNumber(body, "positionMs");
                long seekMs;
                if (!string.IsNullOrEmpty(posStr) && long.TryParse(posStr, out seekMs) && seekMs >= 0)
                {
                    var hwnd = GetPotPlayerHwnd();
                    if (hwnd != IntPtr.Zero)
                    {
                        SeekPotPlayer(hwnd, seekMs);
                        WriteJson(resp, "{\"status\":\"ok\",\"positionMs\":" + seekMs + "}");
                    }
                    else
                    {
                        WriteJson(resp, "{\"status\":\"error\",\"message\":\"PotPlayer not running\"}");
                    }
                }
                else
                {
                    WriteJson(resp, "{\"status\":\"error\",\"message\":\"Invalid positionMs\"}");
                }
            }
            catch (Exception e)
            {
                Log("Seek error: " + e.Message);
                try { WriteJson(resp, "{\"status\":\"error\",\"message\":\"" + EscapeJson(e.Message) + "\"}"); } catch { }
            }
        }
        else
        {
            resp.StatusCode = 404;
            try { WriteJson(resp, "{\"error\":\"not found\"}"); } catch { }
        }
    }

    /// <summary>
    /// 从 Jellyfin API 获取文件路径（带 10 秒超时保护）
    /// 避免网络问题导致 HTTP 请求线程阻塞
    /// </summary>
    static string GetFilePathWithTimeout(string serverUrl, string itemId, string apiKey, string userId)
    {
        var task = Task.Run(() => GetFilePathFromJellyfin(serverUrl, itemId, apiKey, userId));
        if (task.Wait(TimeSpan.FromSeconds(10)))
            return task.Result;
        Log("API timeout after 10s");
        return "";
    }

    /// <summary>
    /// 通过 Jellyfin API 获取媒体文件的服务器端路径
    /// 同时解析断点续播位置（PlaybackPositionTicks）
    /// 如果是剧集（Series），自动获取第一集的信息
    /// </summary>
    static string GetFilePathFromJellyfin(string serverUrl, string itemId, string apiKey, string userId)
    {
        currentResumeTicks = 0;

        var wc = new WebClient();
        wc.Headers.Add("X-Emby-Authorization", "MediaBrowser Client=\"jellyfin-ext\", Device=\"PC\", DeviceId=\"ext01\", Version=\"1.0.0\", Token=\"" + apiKey + "\"");
        wc.Headers.Add("Accept-Encoding", "identity");

        // 请求媒体项详情
        var apiUrl = serverUrl.TrimEnd('/') + "/Items/" + itemId + "?api_key=" + apiKey;
        Log("Fetching item details from: " + apiUrl);

        var itemJson = wc.DownloadString(apiUrl);
        Log("API response (first 500): " + (itemJson.Length > 500 ? itemJson.Substring(0, 500) : itemJson));

        // 解析断点续播位置（Jellyfin 使用 ticks，1 tick = 100ns）
        var resumeStr = GetJsonField(itemJson, "PlaybackPositionTicks");
        long ticks;
        if (!string.IsNullOrEmpty(resumeStr) && long.TryParse(resumeStr, out ticks) && ticks > 0)
        {
            currentResumeTicks = ticks;
            Log("Resume position: " + (ticks / 10000000) + "s");
        }

        // 如果是剧集，请求第一集的信息
        var itemType = GetJsonField(itemJson, "Type");
        Log("Item type: [" + itemType + "]");

        if (itemType == "Series")
        {
            Log("Fetching first episode...");
            var epsUrl = serverUrl.TrimEnd('/') + "/Shows/" + itemId + "/Episodes?api_key=" + apiKey;
            if (!string.IsNullOrEmpty(userId))
                epsUrl += "&UserId=" + userId;

            var epsJson = wc.DownloadString(epsUrl);
            var pathKey = "\"Path\":\"";
            int pathStart = epsJson.IndexOf(pathKey);
            if (pathStart > 0)
            {
                pathStart += pathKey.Length;
                int pathEnd = epsJson.IndexOf("\"", pathStart);
                if (pathEnd > 0)
                    return epsJson.Substring(pathStart, pathEnd - pathStart).Replace("\\\\", "\\");
            }
        }

        return GetJsonField(itemJson, "Path");
    }

    // ==================== JSON 解析辅助方法 ====================
    // 手动解析 JSON（不依赖第三方库，保持无外部依赖）

    /// <summary>从 JSON 中获取指定字符串字段的值</summary>
    static string GetJsonField(string json, string field)
    {
        var search = "\"" + field + "\":\"";
        int start = json.IndexOf(search);
        if (start < 0)
        {
            var numVal = GetJsonNumber(json, field);
            if (numVal != null) return numVal;
            return "";
        }
        start += search.Length;
        int end = json.IndexOf("\"", start);
        if (end < 0) return "";
        var val = json.Substring(start, end - start);
        val = val.Replace("\\\\", "\\");
        val = DecodeUnicode(val);
        return val;
    }

    /// <summary>从 JSON 中获取指定数字字段的值（返回字符串形式）</summary>
    static string GetJsonNumber(string json, string field)
    {
        var search = "\"" + field + "\":";
        int start = json.IndexOf(search);
        if (start < 0) return null;
        start += search.Length;
        while (start < json.Length && json[start] == ' ') start++;
        int end = start;
        while (end < json.Length && json[end] != ',' && json[end] != '}' && json[end] != ']') end++;
        if (end <= start) return null;
        return json.Substring(start, end - start).Trim();
    }

    /// <summary>解码 JSON 中的 Unicode 转义序列（如 \uXXXX）</summary>
    static string DecodeUnicode(string s)
    {
        var sb = new StringBuilder();
        for (int i = 0; i < s.Length; i++)
        {
            if (i + 5 < s.Length && s[i] == '\\' && s[i + 1] == 'u')
            {
                var hex = s.Substring(i + 2, 4);
                try { sb.Append((char)Convert.ToInt32(hex, 16)); i += 5; }
                catch { sb.Append(s[i]); }
            }
            else sb.Append(s[i]);
        }
        return sb.ToString();
    }

    /// <summary>
    /// 路径映射：将 NAS 路径前缀替换为本地路径前缀
    /// 例如：/volume1/video/movie.mkv → Z:\movie.mkv
    /// </summary>
    static string TranslatePath(string serverPath)
    {
        if (string.IsNullOrEmpty(serverPath)) return "";
        if (string.IsNullOrEmpty(nasPathPrefix) || string.IsNullOrEmpty(localPathPrefix))
            return "";
        if (serverPath.StartsWith(nasPathPrefix))
        {
            var localPath = localPathPrefix + serverPath.Substring(nasPathPrefix.Length);
            localPath = localPath.Replace("/", "\\");
            return localPath;
        }
        return "";
    }

    /// <summary>简易 JSON 字符串解析（从 JSON 中提取指定 key 的字符串值）</summary>
    static string ParseJsonStr(string json, string key)
    {
        var search = "\"" + key + "\":\"";
        int start = json.IndexOf(search);
        if (start < 0) return "";
        start += search.Length;
        int end = json.IndexOf("\"", start);
        if (end < 0) return "";
        return json.Substring(start, end - start).Replace("\\\\", "\\");
    }

    /// <summary>转义 JSON 字符串中的特殊字符</summary>
    static string EscapeJson(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    /// <summary>将 JSON 字符串写入 HTTP 响应</summary>
    static void WriteJson(HttpListenerResponse resp, string json)
    {
        byte[] data = Encoding.UTF8.GetBytes(json);
        resp.ContentType = "application/json";
        resp.AddHeader("Access-Control-Allow-Origin", "*");
        resp.ContentLength64 = data.Length;
        try { resp.OutputStream.Write(data, 0, data.Length); } catch { }
        try { resp.OutputStream.Close(); } catch { }
    }

    // ==================== PotPlayer 控制方法 ====================
    // 通过 Windows 消息机制与 PotPlayer 通信

    /// <summary>获取 PotPlayer 主窗口句柄（支持 64 位和 32 位版本）</summary>
    static IntPtr GetPotPlayerHwnd()
    {
        var hwnd = FindWindow("PotPlayer64", null);
        if (hwnd != IntPtr.Zero) return hwnd;
        return FindWindow("PotPlayer", null);
    }

    /// <summary>获取当前播放位置（毫秒）</summary>
    static long GetPotPlayerPositionMs(IntPtr hwnd)
    {
        var result = SendMessage(hwnd, WM_USER, (IntPtr)PPM_GET_CURRENT_TIME, IntPtr.Zero);
        return result.ToInt64();
    }

    /// <summary>获取视频总时长（毫秒）</summary>
    static long GetPotPlayerDurationMs(IntPtr hwnd)
    {
        var result = SendMessage(hwnd, WM_USER, (IntPtr)PPM_GET_TOTAL_TIME, IntPtr.Zero);
        return result.ToInt64();
    }

    /// <summary>获取播放状态（-1=停止，0=播放，1=暂停）</summary>
    static int GetPotPlayerStatus(IntPtr hwnd)
    {
        var result = SendMessage(hwnd, WM_USER, (IntPtr)PPM_GET_PLAY_STATUS, IntPtr.Zero);
        return result.ToInt32();
    }

    /// <summary>跳转到指定播放位置（毫秒）</summary>
    static void SeekPotPlayer(IntPtr hwnd, long positionMs)
    {
        SendMessage(hwnd, WM_USER, (IntPtr)PPM_SET_CURRENT_TIME, (IntPtr)positionMs);
        lastPosMs = positionMs;
        if (positionMs > maxPosMs) maxPosMs = positionMs;
        Log("Seeked to " + (positionMs / 1000) + "s");
    }

    // ==================== Jellyfin 状态汇报 ====================
    // 通过 Jellyfin API 向服务端汇报播放状态

    /// <summary>向 Jellyfin API 发送 POST 请求</summary>
    static void JellyfinPost(string serverUrl, string apiKey, string path, string json)
    {
        try
        {
            var wc = new WebClient();
            wc.Headers.Add("Content-Type", "application/json");
            wc.Headers.Add("X-Emby-Authorization", "MediaBrowser Client=\"jellyfin-ext\", Device=\"PC\", DeviceId=\"ext01\", Version=\"1.0.0\", Token=\"" + apiKey + "\"");
            wc.Headers.Add("Accept-Encoding", "identity");
            var url = serverUrl.TrimEnd('/') + path + (path.Contains("?") ? "&" : "?") + "api_key=" + apiKey;
            wc.UploadString(url, "POST", json);
        }
        catch (Exception e)
        {
            Log("Jellyfin API error: " + e.Message);
        }
    }

    /// <summary>汇报播放开始事件</summary>
    static void ReportPlaybackStart()
    {
        var json = "{" +
            "\"ItemId\":\"" + currentItemId + "\"," +
            "\"PlaySessionId\":\"" + currentPlaySessionId + "\"," +
            "\"MediaSourceId\":\"" + currentItemId + "\"," +
            "\"PlayMethod\":\"DirectPlay\"," +
            "\"CanSeek\":true" +
            "}";
        Log("Reporting playback start...");
        JellyfinPost(currentServerUrl, currentApiKey, "/Sessions/Playing", json);
    }

    /// <summary>汇报播放进度更新（每秒调用）</summary>
    static void ReportPlaybackProgress(long positionMs, bool isPaused)
    {
        var ticks = positionMs * 10000;  // ms → ticks（1ms = 10000 ticks）
        var json = "{" +
            "\"ItemId\":\"" + currentItemId + "\"," +
            "\"PlaySessionId\":\"" + currentPlaySessionId + "\"," +
            "\"MediaSourceId\":\"" + currentItemId + "\"," +
            "\"PositionTicks\":" + ticks + "," +
            "\"IsPaused\":" + (isPaused ? "true" : "false") + "," +
            "\"IsMuted\":false," +
            "\"PlayMethod\":\"DirectPlay\"," +
            "\"EventName\":\"timeupdate\"," +
            "\"RepeatMode\":\"RepeatNone\"" +
            "}";
        JellyfinPost(currentServerUrl, currentApiKey, "/Sessions/Playing/Progress", json);
    }

    /// <summary>汇报播放停止事件</summary>
    static void ReportPlaybackStopped(long positionMs)
    {
        var ticks = positionMs * 10000;
        var json = "{" +
            "\"ItemId\":\"" + currentItemId + "\"," +
            "\"PlaySessionId\":\"" + currentPlaySessionId + "\"," +
            "\"MediaSourceId\":\"" + currentItemId + "\"," +
            "\"PositionTicks\":" + ticks + "," +
            "\"PlayMethod\":\"DirectPlay\"" +
            "}";
        Log("Reporting playback stopped at " + (positionMs / 1000) + "s");
        JellyfinPost(currentServerUrl, currentApiKey, "/Sessions/Playing/Stopped", json);
    }

    /// <summary>将媒体标记为"已观看"</summary>
    static void MarkAsPlayed()
    {
        Log("Marking item as played...");
        JellyfinPost(currentServerUrl, currentApiKey,
            "/Users/" + currentUserId + "/PlayedItems/" + currentItemId, "{}");
    }

    /// <summary>
    /// 启动播放进度跟踪线程
    /// 每秒轮询 PotPlayer 的播放进度，汇报给 Jellyfin
    /// 当播放完成（超过 90%）或窗口关闭时自动停止并标记
    /// </summary>
    static void StartProgressTracker()
    {
        StopProgressTracker();

        currentPlaySessionId = Guid.NewGuid().ToString("N");
        progressCts = new CancellationTokenSource();
        var token = progressCts.Token;
        isPotPlayerRunning = true;
        lastPosMs = 0;
        lastDurMs = 0;
        maxPosMs = 0;

        Log("Starting progress tracker, session=" + currentPlaySessionId);

        Task.Run(() =>
        {
            ReportPlaybackStart();
            var windowWasFound = false;

            while (!token.IsCancellationRequested)
            {
                try
                {
                    Thread.Sleep(1000);  // 每秒轮询一次
                    if (token.IsCancellationRequested) break;

                    var hwnd = GetPotPlayerHwnd();
                    if (hwnd == IntPtr.Zero)
                    {
                        // PotPlayer 窗口已关闭 → 停止跟踪
                        if (windowWasFound)
                        {
                            isPotPlayerRunning = false;
                            Log("PotPlayer window closed, stopped at " + (lastPosMs / 1000) + "s (max was " + (maxPosMs / 1000) + "s)");
                            ReportPlaybackStopped(lastPosMs);
                            if (lastDurMs > 0 && (double)lastPosMs / lastDurMs > 0.9)
                                MarkAsPlayed();
                            break;
                        }
                        Log("PotPlayer window not yet visible, waiting...");
                        continue;
                    }

                    windowWasFound = true;
                    isPotPlayerRunning = true;
                    var posMs = GetPotPlayerPositionMs(hwnd);
                    var durMs = GetPotPlayerDurationMs(hwnd);
                    var status = GetPotPlayerStatus(hwnd);

                    if (posMs > 0)
                        lastPosMs = posMs;

                    if (durMs > 0)
                    {
                        lastDurMs = durMs;
                        if (posMs > maxPosMs) maxPosMs = posMs;
                    }

                    if (lastDurMs > 0)
                    {
                        var safePosMs = posMs > 0 ? posMs : lastPosMs;
                        var percent = (double)safePosMs / lastDurMs * 100;
                        Log("Progress: " + (safePosMs / 1000) + "s / " + (lastDurMs / 1000) + "s (" + percent.ToString("F1") + "%) status=" + status);
                        ReportPlaybackProgress(safePosMs, status == 1);

                        // 播放完成（超过 90%）→ 标记为已观看并停止
                        if (percent > 90)
                        {
                            Log("Playback > 90%, marking as played");
                            ReportPlaybackStopped(safePosMs);
                            MarkAsPlayed();
                            isPotPlayerRunning = false;
                            break;
                        }
                    }

                    // status == -1 表示播放已停止
                    if (status == -1)
                    {
                        if (lastPosMs > 0)
                        {
                            Log("PotPlayer stopped (status=-1), reporting stopped at " + (lastPosMs / 1000) + "s (max was " + (maxPosMs / 1000) + "s)");
                            ReportPlaybackStopped(lastPosMs);
                            if (lastDurMs > 0 && (double)maxPosMs / lastDurMs > 0.9)
                                MarkAsPlayed();
                            isPotPlayerRunning = false;
                            break;
                        }
                        if (windowWasFound && (lastPosMs > 0 || lastDurMs > 0))
                        {
                            isPotPlayerRunning = false;
                            break;
                        }
                        Log("PotPlayer status=-1 but no data yet, waiting...");
                    }
                }
                catch (Exception e)
                {
                    Log("Progress tracker error: " + e.Message);
                }
            }
            Log("Progress tracker ended");
        }, token);
    }

    /// <summary>停止播放进度跟踪线程</summary>
    static void StopProgressTracker()
    {
        isPotPlayerRunning = false;
        if (progressCts != null)
        {
            try { progressCts.Cancel(); } catch { }
            try { progressCts.Dispose(); } catch { }
            progressCts = null;
        }
    }

    /// <summary>
    /// 日志记录（追加到 server.log 文件）
    /// 格式：HH:mm:ss 消息内容
    /// </summary>
    static void Log(string msg)
    {
        try
        {
            var line = DateTime.Now.ToString("HH:mm:ss") + " " + msg + Environment.NewLine;
            File.AppendAllText(logPath, line);
        }
        catch { }
    }
}
