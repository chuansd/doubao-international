/**
 * forwarder.js — ISOLATED world
 * 消息桥接：content.js (MAIN) ↔ background.js (service worker)
 *
 * content.js 运行在 MAIN world，无法直接访问 chrome.runtime API，
 * 因此所有需要后台服务的操作都通过 postMessage 发送至此，
 * 由本脚本转发到 background.js。
 */

// ============================================================
//  content → background 转发
// ============================================================
window.addEventListener('message', function (e) {
  const msg = e.data
  if (!msg || typeof msg !== 'object') return

  // --- 下载请求 ---
  if (msg.type === '__DF_download') {
    chrome.runtime.sendMessage(
      { type: '__DF_download', url: msg.url, filename: msg.filename },
      function (res) {
        // 将结果送回 content.js
        window.postMessage(
          { type: '__DF_downloadResult', __cbId: msg.__cbId, success: res?.success, error: res?.error },
          '*'
        )
      }
    )
    return
  }

  // --- 视频发现（通知 background 统计）---
  if (msg.type === '__DF_videoFound') {
    chrome.runtime.sendMessage({ type: '__DF_videoFound', messageId: msg.messageId, vid: msg.vid })
    return
  }

  // --- 获取视频URL（备用方案）---
  if (msg.type === '__DF_getVideoUrl') {
    handleGetVideoUrl(msg.vid)
    return
  }
})

// ============================================================
//  background → content 转发
// ============================================================
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  // 模式切换
  if (msg.type === '__DF_modeChanged') {
    window.postMessage({ type: '__DF_modeChanged', value: msg.value }, '*')
    sendResponse({ success: true })
    return true
  }
})

// ============================================================
//  初始化：读取storage中的15秒模式开关
// ============================================================
chrome.storage.local.get('df_mode15s', function (result) {
  const val = result.df_mode15s === true
  if (val) {
    window.postMessage({ type: '__DF_modeChanged', value: true }, '*')
  }
})

// ============================================================
//  视频URL获取（备用方案 — 通过豆包分享API）
// ============================================================
async function handleGetVideoUrl(vid) {
  // 通过 background 调用豆包分享API获取视频地址
  chrome.runtime.sendMessage(
    { type: '__DF_getVideoShareUrl', vid },
    function (result) {
      window.postMessage({ type: '__DF_videoUrlBack', vid, result }, '*')
    }
  )
}
