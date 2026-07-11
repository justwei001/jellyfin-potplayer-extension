# Plan: Shared Progress Bar for PotPlayer ↔ Jellyfin

## Goal
Add a real-time progress bar on the Jellyfin detail page that shows PotPlayer's current playback position, updates every second, and supports click-to-seek.

## Architecture

```
┌─────────────┐    HTTP/1s     ┌──────────────┐    Win32 API    ┌──────────┐
│  content.js │ ◄──poll /status── │ player_server │ ◄──SendMessage── │ PotPlayer│
│  (进度条UI)  │ ──POST /seek───► │  (C# exe)     │ ──SendMessage──► │          │
└─────────────┘                 └──────────────┘                 └──────────┘
                                       │
                                       │ POST /Sessions/Playing/Progress
                                       ▼
                                 ┌──────────┐
                                 │ Jellyfin │
                                 │  Server  │
                                 └──────────┘
```

## Files to Modify

1. **`I:\ai\ai-projects\jellyfin-potplayer-host\player_server.cs`** — Add `/seek` endpoint
2. **`I:\ai\ai项目\jellyfin-potplayer-extension\content.js`** — Inject progress bar UI + polling + click-to-seek

---

- [x] Task 1: Server — Add `/seek` endpoint

### File: `I:\ai\ai-projects\jellyfin-potplayer-host\player_server.cs`

**Change 1a:** Add `PPM_SET_CURRENT_TIME` constant (line ~23):
```csharp
const int PPM_GET_TOTAL_TIME = 0x5002;
const int PPM_SET_CURRENT_TIME = 0x5003;  // ADD THIS
const int PPM_GET_CURRENT_TIME = 0x5004;
const int PPM_GET_PLAY_STATUS = 0x5006;
```

**Change 1b:** Add `SeekPotPlayer` method (after `GetPotPlayerStatus`, around line 410):
```csharp
static void SeekPotPlayer(IntPtr hwnd, long positionMs)
{
    SendMessage(hwnd, WM_USER, (IntPtr)PPM_SET_CURRENT_TIME, (IntPtr)positionMs);
    lastPosMs = positionMs;
    if (positionMs > maxPosMs) maxPosMs = positionMs;
    Log("Seeked to " + (positionMs / 1000) + "s");
}
```

**Change 1c:** Add `/seek` endpoint in `ProcessRequest` (after the `/status` block, before `else` at line 236):
```csharp
else if (req.Url.AbsolutePath == "/seek" && req.HttpMethod == "POST")
{
    try
    {
        var reader = new StreamReader(req.InputStream, Encoding.UTF8);
        var body = reader.ReadToEnd();
        var posStr = ParseJsonNumber(body, "positionMs");
        if (!string.IsNullOrEmpty(posStr) && long.TryParse(posStr, out long seekMs) && seekMs >= 0)
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
```

**Note:** `ParseJsonNumber` already exists in the codebase (line 318). It returns a string for numeric JSON values.

**Verification:** [x] Build the server exe — compiled with csc.exe (C# 5 compat: `out long` → separate declaration). Start it. Run `curl -X POST http://localhost:58000/seek -d '{"positionMs":60000}'` — should return `{"status":"ok","positionMs":60000}` and PotPlayer should seek.

---

- [x] Task 2: Extension — Inject progress bar UI

### File: `I:\ai\ai项目\jellyfin-potplayer-extension\content.js`

**Change 2a:** Add CSS styles for the progress bar (inject a `<style>` element once):
```javascript
function injectStyles() {
    if (document.getElementById('pp-ext-styles')) return;
    var style = document.createElement('style');
    style.id = 'pp-ext-styles';
    style.textContent = `
        #pp-progress-container {
            width: 100%;
            padding: 8px 0;
            margin-top: 4px;
        }
        #pp-progress-bar {
            position: relative;
            width: 100%;
            height: 6px;
            background: rgba(255,255,255,0.2);
            border-radius: 3px;
            cursor: pointer;
            overflow: visible;
        }
        #pp-progress-bar:hover {
            height: 10px;
        }
        #pp-progress-fill {
            height: 100%;
            background: #4fc3f7;
            border-radius: 3px;
            width: 0%;
            transition: width 0.3s linear;
        }
        #pp-progress-bar:hover #pp-progress-fill {
            background: #81d4fa;
        }
        #pp-progress-text {
            font-size: 12px;
            color: rgba(255,255,255,0.7);
            margin-top: 2px;
            text-align: center;
        }
        #pp-progress-label {
            font-size: 11px;
            color: #4fc3f7;
            text-align: center;
            margin-top: 2px;
        }
    `;
    document.head.appendChild(style);
}
```

**Change 2b:** Add progress bar injection function:
```javascript
function injectProgressBar() {
    if (!config.enabled || !getVideoId()) return;

    var existingBar = document.getElementById('pp-progress-container');
    var detailBtns = document.querySelector('.mainDetailButtons.focuscontainer-x, .mainDetailButtons');

    // Only inject if on detail page with buttons area
    if (!detailBtns || existingBar) return;

    // Create progress bar container
    var container = document.createElement('div');
    container.id = 'pp-progress-container';
    container.innerHTML = `
        <div id="pp-progress-label"></div>
        <div id="pp-progress-bar">
            <div id="pp-progress-fill"></div>
        </div>
        <div id="pp-progress-text">--:-- / --:--</div>
    `;

    // Insert after the mainDetailButtons
    detailBtns.parentNode.insertBefore(container, detailBtns.nextSibling);

    // Add click-to-seek handler
    var bar = document.getElementById('pp-progress-bar');
    bar.addEventListener('click', function(e) {
        var rect = bar.getBoundingClientRect();
        var percent = (e.clientX - rect.left) / rect.width;
        percent = Math.max(0, Math.min(1, percent));

        // Get current duration from the bar's data attribute
        var durMs = parseInt(bar.dataset.durationMs || '0');
        if (durMs <= 0) return;

        var seekMs = Math.round(percent * durMs);
        seekTo(seekMs);
    });

    console.log('[PP] Progress bar injected!');
}
```

**Change 2c:** Add `seekTo` function:
```javascript
function seekTo(positionMs) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', SERVER_URL + '/seek', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
        console.log('[PP] Seek response: ' + xhr.responseText);
    };
    xhr.onerror = function() {
        console.log('[PP] Seek failed - server not running');
    };
    xhr.send(JSON.stringify({ positionMs: positionMs }));
}
```

**Change 2d:** Add `formatTime` helper:
```javascript
function formatTime(ms) {
    if (ms <= 0) return '--:--';
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    return m + ':' + (s < 10 ? '0' : '') + s;
}
```

---

- [x] Task 3: Extension — Poll /status and update progress bar

### File: `I:\ai\ai项目\jellyfin-potplayer-extension\content.js`

**Change 3a:** Add progress polling function:
```javascript
var progressPollTimer = null;

function startProgressPolling() {
    if (progressPollTimer) return;
    progressPollTimer = setInterval(pollProgress, 1000);
}

function stopProgressPolling() {
    if (progressPollTimer) {
        clearInterval(progressPollTimer);
        progressPollTimer = null;
    }
}

function pollProgress() {
    var bar = document.getElementById('pp-progress-bar');
    if (!bar) return;

    var xhr = new XMLHttpRequest();
    xhr.open('GET', SERVER_URL + '/status', true);
    xhr.onload = function() {
        try {
            var data = JSON.parse(xhr.responseText);
            updateProgressBar(data);
        } catch (e) {}
    };
    xhr.onerror = function() {};
    xhr.send();
}

function updateProgressBar(data) {
    var fill = document.getElementById('pp-progress-fill');
    var text = document.getElementById('pp-progress-text');
    var label = document.getElementById('pp-progress-label');
    var bar = document.getElementById('pp-progress-bar');
    var container = document.getElementById('pp-progress-container');

    if (!fill || !text || !container) return;

    if (!data.isPlaying || data.durationMs <= 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = '';
    var posMs = data.positionMs;
    var durMs = data.durationMs;
    var percent = Math.min(100, (posMs / durMs) * 100);

    fill.style.width = percent + '%';
    text.textContent = formatTime(posMs) + ' / ' + formatTime(durMs);
    bar.dataset.durationMs = durMs;

    // Show label with item info if available
    if (data.itemId && label) {
        label.textContent = 'PotPlayer 同步中';
    }
}
```

**Change 3b:** Update `inject()` to also inject progress bar and start polling:
```javascript
// At the end of inject(), after the existing button injection logic:
injectStyles();
injectProgressBar();
startProgressPolling();
```

**Change 3c:** Keep the MutationObserver but also run progress polling:
Replace the existing observer + inject() call at the bottom with:
```javascript
var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
            inject();
            break;
        }
    }
});
observer.observe(document.body, { childList: true, subtree: true });
inject();
```

---

- [~] Task 4: Manual QA (blocked — requires user to run server and test in browser; server exe now compiled)

**Scenario 1 — Progress bar appears on detail page:**
1. Start server: `I:\ai\ai-projects\jellyfin-potplayer-host\start_server.bat`
2. Open Jellyfin detail page for any video
3. Verify: Blue progress bar appears below the play buttons area
4. Expected: Progress bar shows "--:-- / --:--" when PotPlayer is not running

**Scenario 2 — Real-time progress sync:**
1. Click PotPlayer button to start playback
2. Wait 3+ seconds
3. Verify: Progress bar fills with blue, shows "MM:SS / HH:MM:SS"
4. Verify: Progress advances every second as video plays

**Scenario 3 — Click-to-seek:**
1. While PotPlayer is playing, click middle of progress bar
2. Verify: PotPlayer seeks to ~50% position
3. Verify: Progress bar jumps to clicked position
4. Verify: server.log shows "Seeked to Xs"

**Scenario 4 — PotPlayer closed:**
1. Close PotPlayer
2. Verify: Progress bar hides (container display:none)
3. Verify: server.log shows "Reporting playback stopped"

**Scenario 5 — Resume position:**
1. Play video to ~30%, close PotPlayer
2. Re-open same video in PotPlayer
3. Verify: Progress bar shows correct resume position from Jellyfin
