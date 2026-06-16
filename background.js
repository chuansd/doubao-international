/**
 * background.js — Service Worker
 *
 * 职责：
 *   1. 处理下载请求（chrome.downloads）
 *   2. 转发模式切换通知到所有 tab
 *   3. 响应 popup 的查询
 *   4. 备用视频URL获取
 */

// ============================================================
//  下载
// ============================================================
async function handleDownload(url, filename) {
  try {
    const downloadId = await chrome.downloads.download({
      url: url,
      filename: filename || 'doubao_' + Date.now() + '.mp4',
      saveAs: false,
      conflictAction: 'uniquify'
    })
    return { success: true, downloadId }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ============================================================
//  通知所有 doubao tab 切换模式
// ============================================================
async function broadcastMode(value) {
  await chrome.storage.local.set({ df_mode15s: value })
  const doubaoTabs = await chrome.tabs.query({ url: 'https://www.doubao.com/*' })
  const dolaTabs = await chrome.tabs.query({ url: 'https://www.dola.com/*' })
  const tabs = [...doubaoTabs, ...dolaTabs]
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: '__DF_modeChanged', value }).catch(() => {})
  }
}

// ============================================================
//  消息监听
// ============================================================
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  // --- 下载 ---
  if (msg.type === '__DF_download') {
    handleDownload(msg.url, msg.filename).then(sendResponse)
    return true
  }

  // --- 切换15秒模式 ---
  if (msg.type === '__DF_setMode') {
    broadcastMode(msg.value).then(() => sendResponse({ success: true }))
    return true
  }

  // --- 查询当前模式 ---
  if (msg.type === '__DF_getMode') {
    chrome.storage.local.get('df_mode15s', function (r) {
      sendResponse({ value: r.df_mode15s === true })
    })
    return true
  }

  // --- 视频发现（仅统计）---
  if (msg.type === '__DF_videoFound') {
    // 暂不处理，留作未来扩展
    sendResponse({ success: true })
    return true
  }

  // --- 获取视频分享URL（备用）---
  if (msg.type === '__DF_getVideoShareUrl') {
    const origin = sender.tab?.url ? new URL(sender.tab.url).origin : 'https://www.doubao.com'
    getVideoShareUrl(msg.vid, origin).then(sendResponse)
    return true
  }
})

// ============================================================
//  备用：通过豆包分享API获取视频URL
// ============================================================
async function getVideoShareUrl(vid, origin = 'https://www.doubao.com') {
  try {
    const aid = origin.includes('dola.com') ? '489823' : '497858'
    const url = origin + '/samantha/media/get_play_info?aid=' + aid + '&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version&web_tab_id=' + crypto.randomUUID()
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ key: vid, type: 'video' })
    })
    const j = await resp.json()
    if (j.code === 0 && j.data) {
      const om = j.data.original_media_info
      if (om?.main_url) {
        return { mainUrl: cleanVideoUrl(om.main_url), width: om.width, height: om.height }
      }
      const pi = j.data.play_infos?.[0] || j.data.play_info
      if (pi?.main) {
        return { mainUrl: cleanVideoUrl(pi.main), width: pi.width, height: pi.height }
      }
    }
    return null
  } catch (e) {
    return null
  }
}

// 视频URL去水印处理
function cleanVideoUrl(videoUrl) {
  if (!videoUrl) return videoUrl
  let url = videoUrl
  if (url.includes('lr=')) {
    url = url.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark')
  }
  if (url.includes('watermark')) {
    url = url.replace(/watermark=1/g, 'watermark=0')
    url = url.replace(/~tplv-[^.?&]*watermark[^.?&]*/gi, '')
  }
  if (url.includes('logo=')) {
    url = url.replace(/[&?]logo=[^&]*/g, '')
  }
  return url
}

