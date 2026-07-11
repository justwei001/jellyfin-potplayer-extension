document.getElementById('saveBtn').addEventListener('click', function() {
    var config = {
        potplayerPath: document.getElementById('potplayerPath').value.trim(),
        nasPathPrefix: document.getElementById('nasPathPrefix').value.trim(),
        localPathPrefix: document.getElementById('localPathPrefix').value.trim(),
        enabled: document.getElementById('enabled').checked
    };

    if (!config.potplayerPath) {
        showStatus('请输入 PotPlayer.exe 文件路径', 'error');
        return;
    }

    chrome.storage.local.set(config);
    showStatus('已保存！刷新 Jellyfin 页面生效', 'success');
});

function showStatus(msg, type) {
    var el = document.getElementById('status');
    el.className = 'status ' + (type || '');
    el.textContent = msg;
    el.style.display = 'block';
}

chrome.storage.local.get(['potplayerPath', 'nasPathPrefix', 'localPathPrefix', 'enabled'], function(result) {
    if (result.potplayerPath) document.getElementById('potplayerPath').value = result.potplayerPath;
    if (result.nasPathPrefix) document.getElementById('nasPathPrefix').value = result.nasPathPrefix;
    if (result.localPathPrefix) document.getElementById('localPathPrefix').value = result.localPathPrefix;
    if (result.enabled !== undefined) document.getElementById('enabled').checked = result.enabled;
});
