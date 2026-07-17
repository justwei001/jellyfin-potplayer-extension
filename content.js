/**
 * Jellyfin External Player - 内容注入脚本（content.js）
 * ============================================================
 * 注入到 Jellyfin Web 页面中，执行以下功能：
 * 1. 在视频详情页和播放页添加 "用 PotPlayer 播放" 按钮
 * 2. 底部固定进度条，显示 PotPlayer 播放进度
 * 3. 通过 MutationObserver 监听 SPA 路由变化，自动注入
 * 4. 支持点击进度条跳转播放位置
 *
 * 与本地服务器（端口 58000）通信，由服务器控制 PotPlayer
 * ============================================================
 */
(function() {
    'use strict';

    // 配置对象，从 Chrome Storage 加载
    var config = { potplayerPath: '', enabled: true, nasPathPrefix: '', localPathPrefix: '' };
    var SERVER_URL = 'http://localhost:58000';  // 本地服务器地址

    console.log('[PP] v9 loaded (file+proxy)');

    // ==================== 从 Chrome Storage 读取配置 ====================
    chrome.storage.local.get(['potplayerPath', 'enabled', 'nasPathPrefix', 'localPathPrefix'], function(result) {
        if (result.potplayerPath) config.potplayerPath = result.potplayerPath;
        if (result.enabled !== undefined) config.enabled = result.enabled;
        if (result.nasPathPrefix) config.nasPathPrefix = result.nasPathPrefix;
        if (result.localPathPrefix) config.localPathPrefix = result.localPathPrefix;
        console.log('[PP] Config loaded');
    });

    /**
     * 从 Jellyfin 的 localStorage 中提取认证信息
     * 遍历所有 storage 项，查找包含 Servers 数组的 JSON 数据
     * @returns {{url: string, key: string, userId: string}|null}
     */
    function getAuth() {
        for (var i = 0; i < localStorage.length; i++) {
            try {
                var k = localStorage.key(i);
                var d = JSON.parse(localStorage.getItem(k));
                if (d && d.Servers && d.Servers[0] && d.Servers[0].AccessToken)
                    return {
                        url: d.Servers[0].ManualAddress || d.Servers[0].LocalAddress || d.Servers[0].RemoteAddress,
                        key: d.Servers[0].AccessToken,
                        userId: d.Servers[0].UserId
                    };
            } catch(e) {}
        }
        return null;
    }

    /**
     * 从 URL hash 中解析视频 ID
     * Jellyfin 详情页 URL 格式：#!/details?id=xxxxxxxx...
     * @returns {string|null} 32 位十六进制 ID
     */
    function getVideoId() {
        var m = location.hash.match(/id=([a-f0-9]{32})/i);
        return m ? m[1] : null;
    }

    /**
     * 核心功能：发送播放请求到本地服务器
     * 服务器启动 PotPlayer 并处理文件路径映射和代理
     */
    function openInPotPlayer() {
        if (!config.potplayerPath) {
            alert('请在扩展设置中配置 PotPlayer 路径');
            return;
        }
        var auth = getAuth();
        var itemId = getVideoId();
        if (!auth || !itemId) {
            alert('无法获取视频信息');
            return;
        }

        var xhr = new XMLHttpRequest();
        xhr.open('POST', SERVER_URL + '/play', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function() {
            var resp = JSON.parse(xhr.responseText);
            if (resp.status === 'success') {
                console.log('[PP] ' + (resp.mode === 'file' ? 'Local file: ' + resp.path : 'Proxy: ' + resp.url));
            } else {
                alert('启动失败: ' + (resp.message || ''));
            }
        };
        xhr.onerror = function() {
            alert('连接服务器失败！请先运行本地服务器 (start_server.bat)');
        };
        xhr.send(JSON.stringify({
            potplayerPath: config.potplayerPath,
            itemId: itemId,
            serverUrl: auth.url,
            apiKey: auth.key,
            userId: auth.userId,
            nasPathPrefix: config.nasPathPrefix,
            localPathPrefix: config.localPathPrefix
        }));
    }

    /**
     * 创建 PotPlayer 播放按钮
     * @param {string} id - 按钮 DOM ID
     * @param {HTMLElement} parent - 父容器
     */
    function createBtn(id, parent) {
        if (!parent) return;
        var btn = document.createElement('button');
        btn.id = id;
        btn.className = 'paper-icon-button-light autoSize';
        btn.title = '用 PotPlayer 播放';
        btn.innerHTML = '<span class="xlargePaperIconButton material-icons" style="color:#4fc3f7;">play_circle</span>';
        btn.style.cssText = 'margin-left:8px;';
        btn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            openInPotPlayer();
        };
        parent.appendChild(btn);
    }

    // ==================== 进度条样式注入 ====================

    /** 向页面注入进度条所需的 CSS 样式 */
    function injectStyles() {
        if (document.getElementById('pp-ext-styles')) return;
        var style = document.createElement('style');
        style.id = 'pp-ext-styles';
        style.textContent = [
            // 底部固定定位的进度条容器
            '#pp-progress-container{position:fixed;bottom:0;left:0;right:0;z-index:99999;padding:4px 16px 6px;background:rgba(20,20,30,.85);backdrop-filter:blur(6px);border-top:1px solid rgba(79,195,247,.2)}',
            '#pp-progress-header{display:none}',
            // 进度条轨道
            '#pp-progress-bar{width:100%;height:3px;background:rgba(255,255,255,.1);border-radius:2px;cursor:pointer;transition:height .15s ease}',
            '#pp-progress-bar:hover{height:6px}',
            // 进度条填充
            '#pp-progress-fill{height:100%;background:#4fc3f7;border-radius:2px;width:0%;transition:width .5s linear}',
            '#pp-progress-bar:hover #pp-progress-fill{background:#81d4fa}',
            // 时间文本
            '#pp-progress-text{font-size:11px;color:rgba(255,255,255,.5);margin-top:3px;font-variant-numeric:tabular-nums;text-align:right}'
        ].join('');
        document.head.appendChild(style);
    }

    // ==================== 时间格式化 ====================

    /**
     * 将毫秒格式化为可读时间字符串
     * @param {number} ms - 毫秒数
     * @returns {string} 格式如 "1:23:45" 或 "23:45"
     */
    function formatTime(ms) {
        if (!ms || ms <= 0) return '--:--';
        var totalSec = Math.floor(ms / 1000);
        var h = Math.floor(totalSec / 3600);
        var m = Math.floor((totalSec % 3600) / 60);
        var s = totalSec % 60;
        if (h > 0) {
            return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        }
        return m + ':' + String(s).padStart(2, '0');
    }

    // ==================== 跳转播放 ====================

    /**
     * 通过本地服务器 API 跳转到指定播放位置
     * @param {number} positionMs - 目标位置（毫秒）
     */
    function seekTo(positionMs) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', SERVER_URL + '/seek', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ positionMs: Math.round(positionMs) }));
        console.log('[PP] Seek to ' + Math.round(positionMs) + 'ms');
    }

    // ==================== 进度轮询系统 ====================

    var progressPollTimer = null;  // 轮询定时器句柄

    /** 每秒查询 /status 接口，获取 PotPlayer 播放进度 */
    function pollProgress() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', SERVER_URL + '/status', true);
        xhr.onload = function () {
            try {
                var data = JSON.parse(xhr.responseText);
                updateProgressBar(data);
            } catch (e) {
                console.warn('[PP] Failed to parse /status:', e);
            }
        };
        xhr.onerror = function () {
            // 服务器未运行时保持静默
        };
        xhr.send();
    }

    /**
     * 根据服务器返回的状态更新进度条显示
     * PotPlayer 不在播放时，回退显示 Jellyfin 自身记录的进度
     */
    function updateProgressBar(data) {
        var bar = document.getElementById('pp-progress-bar');
        if (!bar) return;
        var fill = document.getElementById('pp-progress-fill');
        var text = document.getElementById('pp-progress-text');
        var label = document.getElementById('pp-progress-label');
        var status = document.getElementById('pp-progress-status');
        var container = document.getElementById('pp-progress-container');
        if (!container) return;

        var durationMs = data.durationMs || 0;
        var positionMs = data.positionMs || 0;
        var isPlaying = data.isPlaying === true;

        bar.dataset.durationMs = durationMs;

        if (!isPlaying || durationMs <= 0) {
            // PotPlayer 未播放 → 显示 Jellyfin 的本地进度
            fill.style.width = '0%';
            text.textContent = '--:-- / --:--';
            if (label) label.textContent = 'PotPlayer';
            if (status) status.textContent = '未连接';
            syncJellyfinProgress(bar, fill, text, label, status);
            return;
        }

        var pct = Math.min(100, (positionMs / durationMs) * 100);
        fill.style.width = pct.toFixed(2) + '%';
        text.textContent = formatTime(positionMs) + ' / ' + formatTime(durationMs);
        if (label) label.textContent = 'PotPlayer';
        if (status) status.textContent = '播放中';
    }

    // ==================== Jellyfin 本地进度同步 ====================

    var _jfCache = null;       // Jellyfin 媒体项缓存
    var _jfCacheTime = 0;      // 缓存时间戳

    /**
     * 从 Jellyfin API 获取媒体项的播放进度
     * 用于 PotPlayer 未连接时显示 Jellyfin 自身记录的进度
     */
    function syncJellyfinProgress(bar, fill, text, label, status) {
        try {
            var auth = getAuth();
            var itemId = getVideoId();
            if (!auth || !itemId) return;

            // 5 秒内不重复请求
            var now = Date.now();
            if (_jfCache && _jfCache.itemId === itemId && (now - _jfCacheTime) < 5000) {
                applyJellyfinProgress(_jfCache, bar, fill, text, label, status);
                return;
            }

            var xhr = new XMLHttpRequest();
            xhr.open('GET', auth.url + '/Users/' + auth.userId + '/Items/' + itemId + '?api_key=' + auth.key, true);
            xhr.onload = function() {
                try {
                    var item = JSON.parse(xhr.responseText);
                    _jfCache = item;
                    _jfCacheTime = Date.now();
                    applyJellyfinProgress(item, bar, fill, text, label, status);
                } catch(e) {}
            };
            xhr.send();
        } catch(e) {}
    }

    /**
     * 将 Jellyfin 的播放进度应用到进度条
     * Jellyfin 使用 ticks（100ns）为单位，需转换为毫秒
     */
    function applyJellyfinProgress(item, bar, fill, text, label, status) {
        try {
            var ud = item.UserData;
            if (!ud) return;

            var posTicks = ud.PlaybackPositionTicks || 0;
            var posMs = Math.floor(posTicks / 10000);  // ticks → ms

            var durTicks = item.RunTimeTicks || 0;
            var durMs = Math.floor(durTicks / 10000);

            if (durMs > 0 && posMs > 0) {
                var pct = Math.min(100, (posMs / durMs) * 100);
                fill.style.width = pct.toFixed(2) + '%';
                text.textContent = formatTime(posMs) + ' / ' + formatTime(durMs);
                bar.dataset.durationMs = durMs;
                if (label) label.textContent = 'Jellyfin';
                if (status) status.textContent = '观看进度 ' + Math.round(pct) + '%';
            } else {
                fill.style.width = '0%';
                text.textContent = '--:-- / --:--';
                if (label) label.textContent = 'Jellyfin';
                if (status) status.textContent = posMs > 0 ? '有进度记录' : '未观看';
            }
        } catch(e) {}
    }

    /** 启动每秒轮询 */
    function startProgressPolling() {
        stopProgressPolling();
        progressPollTimer = setInterval(pollProgress, 1000);
    }

    /** 停止进度轮询 */
    function stopProgressPolling() {
        if (progressPollTimer) {
            clearInterval(progressPollTimer);
            progressPollTimer = null;
        }
    }

    // ==================== 注入底部进度条 ====================

    /** 创建并注入底部固定位置的进度条 DOM 元素 */
    function injectProgressBar() {
        if (!config.enabled || !getVideoId()) return;
        if (document.getElementById('pp-progress-container')) return;

        var container = document.createElement('div');
        container.id = 'pp-progress-container';

        var header = document.createElement('div');
        header.id = 'pp-progress-header';

        var label = document.createElement('span');
        label.id = 'pp-progress-label';
        label.textContent = 'PotPlayer';

        var status = document.createElement('span');
        status.id = 'pp-progress-status';

        header.appendChild(label);
        header.appendChild(status);

        var barWrap = document.createElement('div');
        barWrap.id = 'pp-progress-bar';

        var fill = document.createElement('div');
        fill.id = 'pp-progress-fill';
        barWrap.appendChild(fill);

        var text = document.createElement('div');
        text.id = 'pp-progress-text';
        text.textContent = '--:-- / --:--';

        container.appendChild(header);
        container.appendChild(barWrap);
        container.appendChild(text);

        // 点击进度条跳转到对应位置
        barWrap.addEventListener('click', function (e) {
            e.stopPropagation();
            var rect = barWrap.getBoundingClientRect();
            var pct = (e.clientX - rect.left) / rect.width;
            pct = Math.max(0, Math.min(1, pct));
            var durationMs = parseInt(barWrap.dataset.durationMs, 10) || 0;
            if (durationMs > 0) {
                seekTo(pct * durationMs);
            }
        });

        document.body.appendChild(container);
        console.log('[PP] Progress bar appended to body (fixed bottom)');
    }

    // ==================== 主要注入逻辑 ====================

    /**
     * 尝试向页面注入 PotPlayer 按钮和进度条
     * 支持三种注入位置：
     * 1. 详情页按钮区（mainDetailButtons）
     * 2. 播放页 OSD 控制栏
     * 3. 回退方案：通过播放按钮的父元素定位
     */
    function inject() {
        if (!config.enabled) return;
        var videoId = getVideoId();
        if (!videoId) return;

        // 策略1：注入到详情页按钮区
        // 注意：检查须在容器内而非全局，防止 SPA 导航遗留的旧按钮导致跳过
        var detailBtns = document.querySelector('.mainDetailButtons.focuscontainer-x, .mainDetailButtons');
        if (detailBtns && !detailBtns.querySelector('#pp-ext-btn')) {
            createBtn('pp-ext-btn', detailBtns);
            console.log('[PP] Button injected into detail page!');
        }

        // 策略2：注入到播放页 OSD 控制栏
        var osdBtns = document.querySelector('.osdControls .buttons, .videoOsdBottom .buttons');
        if (osdBtns && !osdBtns.querySelector('#pp-ext-btn-osd')) {
            createBtn('pp-ext-btn-osd', osdBtns);
            console.log('[PP] Button injected into OSD!');
        }

        // 策略3：回退方案 - 按播放图标定位
        if (!detailBtns) {
            var playIcons = document.querySelectorAll('.material-icons.detailButton-icon.play_arrow, .material-icons.detailButton-icon.replay, .material-icons.detailButton-icon.fiber_manual_record');
            if (playIcons.length > 0 && !document.querySelector('#pp-ext-btn')) {
                createBtn('pp-ext-btn', playIcons[playIcons.length - 1].parentElement.parentElement);
                console.log('[PP] Button injected via fallback!');
            }
        }

        // 注入进度条
        injectStyles();
        injectProgressBar();
        startProgressPolling();
    }

    // ==================== SPA 路由变化监听 ====================
    // 使用 MutationObserver 监听 DOM 变化，实现单页应用路由切换时自动重新注入

    var observer = new MutationObserver(function(mutations) {
        try {
            for (var i = 0; i < mutations.length; i++) {
                if (mutations[i].addedNodes.length > 0) {
                    inject();
                    break;
                }
            }
        } catch (e) {
            console.warn('[PP] Observer callback error:', e);
        }
    });

    // 监听 body 子节点和子树变化
    observer.observe(document.body, { childList: true, subtree: true });

    // 页面初始加载时立即执行一次注入
    inject();

    // 兜底方案：每 3 秒检查一次，确保不会因竞态条件漏掉注入
    setInterval(function() {
        try {
            var videoId = getVideoId();
            if (!videoId) return;
            var detailBtns = document.querySelector('.mainDetailButtons.focuscontainer-x, .mainDetailButtons');
            if (!detailBtns) return;
            if (!detailBtns.querySelector('#pp-ext-btn')) {
                createBtn('pp-ext-btn', detailBtns);
                console.log('[PP] Button injected via periodic fallback!');
            }
        } catch (e) {
            console.warn('[PP] Periodic check error:', e);
        }
    }, 3000);
})();
