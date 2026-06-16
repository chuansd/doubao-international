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
function safeDecode(text) {
  try {
    return decodeURIComponent(String(text))
  } catch (_) {
    return String(text)
  }
}

function isLikelyNoWatermarkUrl(url, key = '') {
  const text = (key + ' ' + safeDecode(url || '')).toLowerCase()
  return /no[_-]?watermark|without[_-]?watermark|video_gen_no_watermark|original|origin|raw|watermark=0/.test(text)
}

function isLikelyWatermarkedUrl(url, key = '') {
  const text = (key + ' ' + safeDecode(url || '')).toLowerCase()
  if (isLikelyNoWatermarkUrl(url, key)) return false
  return /watermark=1|water_mark|watermark|logo=|watermark_logo|wm_|lr=cici_ai/i.test(text)
}

function scoreVideoUrlCandidate(candidate) {
  if (!candidate?.url || typeof candidate.url !== 'string' || !candidate.url.startsWith('http')) return -Infinity
  const key = String(candidate.key || '')
  const source = String(candidate.source || '')
  const text = (key + ' ' + source + ' ' + safeDecode(candidate.url)).toLowerCase()
  let score = 0
  if (source.includes('original_media_info')) score += 120
  if (/\b(no[_-]?watermark|no_watermark_url)\b/.test(text)) score += 110
  if (/\b(original|origin|raw)\b/.test(text)) score += 90
  if (text.includes('video_gen_no_watermark')) score += 80
  if (/\bmain(_url)?\b/.test(text)) score += 20
  if (candidate.url.includes('.mp4')) score += 12
  if (candidate.width && candidate.height) score += Math.min(20, Math.round((candidate.width * candidate.height) / 300000))
  if (isLikelyWatermarkedUrl(candidate.url, key + ' ' + source)) score -= 160
  return score
}

function chooseBestVideoUrl(candidates) {
  let best = null
  let bestScore = -Infinity
  for (const candidate of candidates) {
    const score = scoreVideoUrlCandidate(candidate)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

async function getVideoShareUrl(vid, origin = 'https://www.doubao.com') {
  try {
    const tryFetch = async (apiOrigin, aid) => {
      const url = apiOrigin + '/samantha/media/get_play_info?aid=' + aid + '&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version&web_tab_id=' + crypto.randomUUID()
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: vid, type: 'video' })
      })
      const j = await resp.json()
      if (j.code === 0 && j.data) {
        const candidates = []
        const om = j.data.original_media_info
        if (om?.main_url) {
          candidates.push({ 
            key: 'main_url', 
            source: 'original_media_info', 
            url: om.main_url,
            width: om.width || om.meta?.width,
            height: om.height || om.meta?.height 
          })
        }
        candidates.push(
          { key: 'no_watermark_url', source: 'data', url: j.data.no_watermark_url, width: j.data.width, height: j.data.height },
          { key: 'original_url', source: 'data', url: j.data.original_url, width: j.data.width, height: j.data.height },
          { key: 'main_url', source: 'data', url: j.data.main_url, width: j.data.width, height: j.data.height },
          { key: 'video_url', source: 'data', url: j.data.video_url, width: j.data.width, height: j.data.height }
        )
        const playInfos = Array.isArray(j.data.play_infos) ? j.data.play_infos : []
        if (j.data.play_info) playInfos.push(j.data.play_info)
        for (const pi of playInfos) {
          if (!pi || typeof pi !== 'object') continue
          candidates.push(
            { key: 'main', source: 'play_info', url: pi.main, width: pi.width, height: pi.height },
            { key: 'main_url', source: 'play_info', url: pi.main_url, width: pi.width, height: pi.height },
            { key: 'play_url', source: 'play_info', url: pi.play_url, width: pi.width, height: pi.height },
            { key: 'url', source: 'play_info', url: pi.url, width: pi.width, height: pi.height }
          )
        }
        const best = chooseBestVideoUrl(candidates)
        if (best) return { mainUrl: cleanVideoUrl(best.url), width: best.width || null, height: best.height || null }
      }
      return null
    }

    const currentAid = origin.includes('dola.com') ? '489823' : '497858'
    let best = await tryFetch(origin, currentAid)
    
    // 如果当前域名 API 失败（比如 dola.com 遇到地区限制），则尝试另一个域名
    if (!best) {
      if (origin.includes('dola.com')) {
        best = await tryFetch('https://www.doubao.com', '497858')
      } else {
        best = await tryFetch('https://www.dola.com', '489823')
      }
    }

    if (best) return best
  } catch (e) {
    console.error('getVideoShareUrl error:', e)
  }
  return null
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
