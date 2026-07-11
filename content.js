(function() {
    'use strict';

    var config = { potplayerPath: '', enabled: true, nasPathPrefix: '', localPathPrefix: '' };
    var SERVER_URL = 'http://localhost:58000';

    console.log('[PP] v9 loaded (file+proxy)');

    chrome.storage.local.get(['potplayerPath', 'enabled', 'nasPathPrefix', 'localPathPrefix'], function(result) {
        if (result.potplayerPath) config.potplayerPath = result.potplayerPath;
        if (result.enabled !== undefined) config.enabled = result.enabled;
        if (result.nasPathPrefix) config.nasPathPrefix = result.nasPathPrefix;
        if (result.localPathPrefix) config.localPathPrefix = result.localPathPrefix;
        console.log('[PP] Config loaded');
    });

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

    function getVideoId() {
        var m = location.hash.match(/id=([a-f0-9]{32})/i);
        return m ? m[1] : null;
    }

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

    /* ===== Progress Bar Styles ===== */
    function injectStyles() {
        if (document.getElementById('pp-ext-styles')) return;
        var style = document.createElement('style');
        style.id = 'pp-ext-styles';
        style.textContent = [
            '#pp-progress-container{position:fixed;bottom:0;left:0;right:0;z-index:99999;padding:4px 16px 6px;background:rgba(20,20,30,.85);backdrop-filter:blur(6px);border-top:1px solid rgba(79,195,247,.2)}',
            '#pp-progress-header{display:none}',
            '#pp-progress-bar{width:100%;height:3px;background:rgba(255,255,255,.1);border-radius:2px;cursor:pointer;transition:height .15s ease}',
            '#pp-progress-bar:hover{height:6px}',
            '#pp-progress-fill{height:100%;background:#4fc3f7;border-radius:2px;width:0%;transition:width .5s linear}',
            '#pp-progress-bar:hover #pp-progress-fill{background:#81d4fa}',
            '#pp-progress-text{font-size:11px;color:rgba(255,255,255,.5);margin-top:3px;font-variant-numeric:tabular-nums;text-align:right}'
        ].join('');
        document.head.appendChild(style);
    }

    /* ===== Format ms → "H:MM:SS" or "M:SS" ===== */
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

    /* ===== Seek to positionMs via PotPlayer HTTP API ===== */
    function seekTo(positionMs) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', SERVER_URL + '/seek', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ positionMs: Math.round(positionMs) }));
        console.log('[PP] Seek to ' + Math.round(positionMs) + 'ms');
    }

    /* ===== Poll PotPlayer /status every second ===== */
    var progressPollTimer = null;

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
            /* silent — server may not be running */
        };
        xhr.send();
    }

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
            fill.style.width = '0%';
            text.textContent = '--:-- / --:--';
            if (label) label.textContent = 'PotPlayer';
            if (status) status.textContent = '未连接';
            /* Try to show Jellyfin's own progress */
            syncJellyfinProgress(bar, fill, text, label, status);
            return;
        }

        var pct = Math.min(100, (positionMs / durationMs) * 100);
        fill.style.width = pct.toFixed(2) + '%';
        text.textContent = formatTime(positionMs) + ' / ' + formatTime(durationMs);
        if (label) label.textContent = 'PotPlayer';
        if (status) status.textContent = '播放中';
    }

    /* ===== Sync with Jellyfin's native progress when PotPlayer is off ===== */
    var _jfCache = null;
    var _jfCacheTime = 0;

    function syncJellyfinProgress(bar, fill, text, label, status) {
        try {
            var auth = getAuth();
            var itemId = getVideoId();
            if (!auth || !itemId) return;

            /* Don't re-fetch more than once per 5 seconds */
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

    function applyJellyfinProgress(item, bar, fill, text, label, status) {
        try {
            var ud = item.UserData;
            if (!ud) return;

            var posTicks = ud.PlaybackPositionTicks || 0;
            var posMs = Math.floor(posTicks / 10000);

            /* Get duration from RunTimeTicks */
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

    function startProgressPolling() {
        stopProgressPolling();
        progressPollTimer = setInterval(pollProgress, 1000);
    }

    function stopProgressPolling() {
        if (progressPollTimer) {
            clearInterval(progressPollTimer);
            progressPollTimer = null;
        }
    }

    /* ===== Inject fixed-position progress bar ===== */
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

        /* Click-to-seek on the bar */
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

        /* Append to body — fixed positioning keeps it out of the flow, never blocks content */
        document.body.appendChild(container);
        console.log('[PP] Progress bar appended to body (fixed bottom)');
    }

    function inject() {
        if (!config.enabled) return;
        var videoId = getVideoId();
        if (!videoId) return;

        // 1. Detail page: inject into mainDetailButtons
        // Check within the CONTAINER, not globally — SPA navigation may leave
        // a detached pp-ext-btn element in the old page, causing global check to skip
        var detailBtns = document.querySelector('.mainDetailButtons.focuscontainer-x, .mainDetailButtons');
        if (detailBtns && !detailBtns.querySelector('#pp-ext-btn')) {
            createBtn('pp-ext-btn', detailBtns);
            console.log('[PP] Button injected into detail page!');
        }

        // 2. OSD/playback: inject into osdControls .buttons area
        var osdBtns = document.querySelector('.osdControls .buttons, .videoOsdBottom .buttons');
        if (osdBtns && !osdBtns.querySelector('#pp-ext-btn-osd')) {
            createBtn('pp-ext-btn-osd', osdBtns);
            console.log('[PP] Button injected into OSD!');
        }

        // 3. Fallback: if detail page has no .mainDetailButtons but we see play buttons with material-icons
        if (!detailBtns) {
            var playIcons = document.querySelectorAll('.material-icons.detailButton-icon.play_arrow, .material-icons.detailButton-icon.replay, .material-icons.detailButton-icon.fiber_manual_record');
            if (playIcons.length > 0 && !document.querySelector('#pp-ext-btn')) {
                createBtn('pp-ext-btn', playIcons[playIcons.length - 1].parentElement.parentElement);
                console.log('[PP] Button injected via fallback!');
            }
        }

        // 4. Progress bar
        injectStyles();
        injectProgressBar();
        startProgressPolling();
    }

    // Use MutationObserver for reliable SPA detection instead of polling
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

    // Start observing on first load
    observer.observe(document.body, { childList: true, subtree: true });

    // Also run once immediately in case DOM is already ready
    inject();

    // Fallback: periodic check every 3 seconds to catch missed injections
    setInterval(function() {
        try {
            var videoId = getVideoId();
            if (!videoId) return;
            var detailBtns = document.querySelector('.mainDetailButtons.focuscontainer-x, .mainDetailButtons');
            if (!detailBtns) return;
            // Check within THIS container, not globally
            if (!detailBtns.querySelector('#pp-ext-btn')) {
                createBtn('pp-ext-btn', detailBtns);
                console.log('[PP] Button injected via periodic fallback!');
            }
        } catch (e) {
            console.warn('[PP] Periodic check error:', e);
        }
    }, 3000);
})();
