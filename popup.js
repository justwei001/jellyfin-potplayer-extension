/**
 * Jellyfin External Player - PotPlayer 扩展弹窗设置逻辑
 * 负责保存/加载用户配置（PotPlayer 路径、NAS 映射、启用状态）
 */

// 保存按钮点击事件：收集表单数据并写入 Chrome Storage
document.getElementById('saveBtn').addEventListener('click', function() {
    // 收集表单中的配置项
    var config = {
        potplayerPath: document.getElementById('potplayerPath').value.trim(),
        nasPathPrefix: document.getElementById('nasPathPrefix').value.trim(),
        localPathPrefix: document.getElementById('localPathPrefix').value.trim(),
        enabled: document.getElementById('enabled').checked
    };

    // 校验 PotPlayer 路径不能为空
    if (!config.potplayerPath) {
        showStatus('请输入 PotPlayer.exe 文件路径', 'error');
        return;
    }

    // 保存到 Chrome 本地存储（自动同步到 content.js）
    chrome.storage.local.set(config);
    showStatus('已保存！刷新 Jellyfin 页面生效', 'success');
});

/**
 * 显示操作状态提示
 * @param {string} msg - 提示消息内容
 * @param {string} [type] - 提示类型（'success' 或 'error'）
 */
function showStatus(msg, type) {
    var el = document.getElementById('status');
    el.className = 'status ' + (type || '');
    el.textContent = msg;
    el.style.display = 'block';
}

// 页面加载时从 Chrome Storage 读取已保存的配置并填入表单
chrome.storage.local.get(['potplayerPath', 'nasPathPrefix', 'localPathPrefix', 'enabled'], function(result) {
    if (result.potplayerPath) document.getElementById('potplayerPath').value = result.potplayerPath;
    if (result.nasPathPrefix) document.getElementById('nasPathPrefix').value = result.nasPathPrefix;
    if (result.localPathPrefix) document.getElementById('localPathPrefix').value = result.localPathPrefix;
    if (result.enabled !== undefined) document.getElementById('enabled').checked = result.enabled;
});
