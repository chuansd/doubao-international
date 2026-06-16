/**
 * content.js — MAIN world
 * 豆包国际版核心逻辑（支持 doubao.com + dola.com）
 * 
 * 功能：
 *   1. 劫持 JSON.parse → 提取无水印图片URL
 *   2. 劫持 fetch → SSE分流提取视频 + 修改 duration 实现15秒
 *   3. 劫持 XHR → chain/single 提取数据
 *   4. DOM扫描 + MutationObserver → 注入下载按钮
 *   5. 视频URL获取（直接调API）
 * 
 * 注意：本脚本运行在 MAIN world，不能直接调用 chrome.runtime API。
 *       所有需要后台服务的操作（下载、storage）通过 postMessage 交给 forwarder.js。
 */

// ============================================================
//  状态
// ============================================================
let mode15s = false
const imageDb = new Map()       // key(rc_gen_image path) → { no_watermark_url, width, height }
const imageUrlMap = new Map()   // 从图片URL片段 → { no_watermark_url, width, height }（用于dola.com等不同CDN格式）
const videoDb = new Map()        // messageId → vid
const videoUrlDb = new Map()     // vid → { mainUrl, width, height } 直接从API响应中捕获的视频URL
const seenUrls = new Set()
const MAX_SEEN = 200

// Debug mode - 在控制台输入 window.__DF_DEBUG = true 开启
function dbg(...args) {
  if (window.__DF_DEBUG) console.log('[DF]', ...args)
}

// ============================================================
//  原生函数备份
// ============================================================
const _parse     = JSON.parse.bind(JSON)
const _fetch     = window.fetch.bind(window)
const _xhrOpen   = XMLHttpRequest.prototype.open
const _xhrSend   = XMLHttpRequest.prototype.send
const _pushState = history.pushState.bind(history)

// ============================================================
//  工具
// ============================================================

// 从URL中提取 rc_gen_image 路径的 key（doubao.com 原始方式）
function extractFileKey(url) {
  if (!url) return null
  const m = url.match(/rc_gen_image\/([^?~]+)/)
  return m ? m[1] : null
}

// 从 URL 中提取 hash 部分（32位hex，常见于字节CDN URL中的文件标识）
function extractHash(url) {
  if (!url) return null
  const m = url.match(/([0-9a-f]{32})/i)
  return m ? m[1].toLowerCase() : null
}

// 从 URL 中提取所有可能的 key（返回数组）
function extractAllKeys(url) {
  if (!url) return []
  const keys = []
  // rc_gen_image key
  const rcKey = extractFileKey(url)
  if (rcKey) keys.push(rcKey)
  // 路径最后一段（去掉 ~ 缩略图后缀）
  try {
    const u = new URL(url)
    const pathParts = u.pathname.split('/').filter(Boolean)
    if (pathParts.length > 0) {
      let last = pathParts[pathParts.length - 1]
      last = last.split('~')[0]
      if (last.length > 8) keys.push(last)
      // 去掉扩展名也存一份（.jpeg/.png/.webp 可能不同）
      const noExt = last.replace(/\.[a-z]{3,4}$/i, '')
      if (noExt.length > 8 && noExt !== last) keys.push(noExt)
    }
  } catch (_) {}
  // 32位 hex hash
  const hash = extractHash(url)
  if (hash) keys.push(hash)
  return [...new Set(keys)]
}

function walkJSON(obj, visit, depth = 0) {
  if (depth > 20 || obj == null || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    for (const v of obj) walkJSON(v, visit, depth + 1)
  } else {
    visit(obj)
    for (const v of Object.values(obj)) walkJSON(v, visit, depth + 1)
  }
}

function findVid(obj, depth = 0) {
  if (depth > 10 || !obj) return null
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = findVid(v, depth + 1); if (r) return r }
    return null
  }
  if (typeof obj !== 'object') return null
  // 检查多种可能的 vid 字段名
  const vid = obj.vid || obj.video_id || obj.video_key || obj.video_vid
  if (typeof vid === 'string' && vid.length > 5) {
    // 接受 v0 开头（doubao.com）或其他格式（dola.com）
    if (vid.startsWith('v0') || /^[a-zA-Z0-9]{10,}$/.test(vid)) {
      dbg('findVid found:', vid)
      return vid
    }
  }
  for (const v of Object.values(obj)) { const r = findVid(v, depth + 1); if (r) return r }
  return null
}

function isLikelyNoWatermarkUrl(url, key = '') {
  if (!url) return false
  const text = (key + ' ' + safeDecode(url)).toLowerCase()
  return /no[_-]?watermark|without[_-]?watermark|video_gen_no_watermark|original|origin|raw|watermark=0/.test(text)
}

function isLikelyWatermarkedUrl(url, key = '') {
  if (!url) return false
  const text = (key + ' ' + safeDecode(url)).toLowerCase()
  if (isLikelyNoWatermarkUrl(url, key)) return false
  return /watermark=1|water_mark|watermark|logo=|watermark_logo|wm_|lr=cici_ai/i.test(text)
}

function safeDecode(text) {
  try {
    return decodeURIComponent(String(text))
  } catch (_) {
    return String(text)
  }
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
  return best ? { ...best, score: bestScore } : null
}

function rememberVideoUrl(vid, candidates) {
  const best = chooseBestVideoUrl(candidates)
  if (!best) return
  const current = videoUrlDb.get(vid)
  if (current && current.score >= best.score) return
  videoUrlDb.set(vid, {
    mainUrl: best.url,
    width: best.width || null,
    height: best.height || null,
    score: best.score
  })
  dbg('videoUrlDb stored:', vid, 'score=', best.score, '→', best.url.substring(0, 120))
}

async function extractVidFromVideoUrl(videoUrl) {
  if (!videoUrl || videoUrl.startsWith('blob:')) return null
  const readVid = async (resp) => {
    if (!resp?.ok) return null
    const buf = await resp.arrayBuffer()
    const text = new TextDecoder('latin1').decode(new Uint8Array(buf))
    const m = text.match(/vid:(v[0-9a-zA-Z_-]{10,})/)
    return m ? m[1] : null
  }
  try {
    const ranged = await _fetch(videoUrl, { headers: { range: 'bytes=0-2097151' } })
    const vid = await readVid(ranged)
    if (vid) return vid
  } catch (_) {}
  try {
    return await readVid(await _fetch(videoUrl))
  } catch (_) {
    return null
  }
}

function isAcceptableVideoResult(result) {
  return !!(result?.mainUrl && !isLikelyWatermarkedUrl(result.mainUrl, 'resolved video'))
}

// 深度修改 duration（15秒模式）
// 豆包请求体中 duration 在 chat_ability.ability_param JSON 字符串内部
function patchDuration(obj, depth = 0) {
  if (depth > 20 || obj == null || typeof obj !== 'object') return false
  let changed = false
  if (Array.isArray(obj)) {
    for (const v of obj) { if (patchDuration(v, depth + 1)) changed = true }
  } else {
    // 关键：找到 chat_ability.ability_type === 17（视频生成）
    // 并将 ability_param 中的 model + duration 修改
    if (obj.chat_ability && Number(obj.chat_ability.ability_type) === 17) {
      const ability = obj.chat_ability
      if (typeof ability.ability_param === 'string') {
        try {
          const param = JSON.parse(ability.ability_param)
          if (param && typeof param === 'object') {
            param.model = 'seedance_v2.0'
            param.duration = 15
            ability.ability_param = JSON.stringify(param)
            changed = true
          }
        } catch (_) {}
      } else if (ability.ability_param && typeof ability.ability_param === 'object') {
        ability.ability_param.model = 'seedance_v2.0'
        ability.ability_param.duration = 15
        changed = true
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k !== 'chat_ability' && patchDuration(v, depth + 1)) changed = true
    }
  }
  return changed
}

// ============================================================
//  提取
// ============================================================

function storeImageData(url, data) {
  // 使用所有可能的 key 进行索引
  const keys = extractAllKeys(url)
  for (const key of keys) {
    // rc_gen_image key 同时存到 imageDb（doubao.com 兼容）
    const rcKey = extractFileKey(url)
    if (rcKey && !imageDb.has(rcKey)) {
      imageDb.set(rcKey, data)
      dbg('imageDb stored (rc_key):', rcKey)
    }
    // 所有 key 存到 imageUrlMap
    if (!imageUrlMap.has(key)) {
      imageUrlMap.set(key, data)
      dbg('imageUrlMap stored:', key)
    }
  }
}

// 从 creation 对象中收集所有图片 URL（用于建立更完整的索引）
function collectImageUrls(cr) {
  const urls = []
  if (!cr) return urls
  // 遍历 image 对象的所有字段
  const img = cr.image || cr
  if (img) {
    for (const [k, v] of Object.entries(img)) {
      if (v && typeof v === 'object' && v.url && typeof v.url === 'string') {
        urls.push(v.url)
      } else if (typeof v === 'string' && v.startsWith('http') && (v.includes('byteimg') || v.includes('bytedapm') || v.includes('byte') || v.includes('dola') || v.includes('doubao'))) {
        urls.push(v)
      }
    }
  }
  return urls
}

function extractImages(creations) {
  if (!Array.isArray(creations)) return
  for (const cr of creations) {
    const raw = cr?.image?.image_ori_raw
    if (raw?.url) {
      const data = { no_watermark_url: raw.url, width: raw.width, height: raw.height }
      storeImageData(raw.url, data)
      // 索引该 creation 中所有能找到的图片 URL（含缩略图、水印版等）
      const allUrls = collectImageUrls(cr)
      for (const u of allUrls) {
        if (u === raw.url) continue
        const keys = extractAllKeys(u)
        for (const key of keys) {
          if (!imageUrlMap.has(key)) {
            imageUrlMap.set(key, data)
            dbg('imageUrlMap stored (variant):', key)
          }
        }
      }
    }
  }
}

function extractVideos(messages) {
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    const mid = String(msg?.message_id || '').trim()
    if (!mid || mid === '0') continue
    const vid = findVid(msg)
    if (vid && !videoDb.has(mid)) {
      videoDb.set(mid, vid)
      post({ type: '__DF_videoFound', messageId: mid, vid })
    }
  }
}

function harvest(obj) {
  try {
    walkJSON(obj, node => {
      const creations = node?.content?.creation_block?.creations
      if (creations) extractImages(creations)

      // doubao.com 路径
      const msgs = node?.downlink_body?.pull_singe_chain_downlink_body?.messages
      if (msgs) {
        extractImagesFromMessages(msgs)
        extractVideos(msgs)
      }

      const ops = node?.patch_op
      if (Array.isArray(ops)) {
        for (const op of ops) {
          const blocks = op?.patch_value?.content_block
          if (Array.isArray(blocks)) {
            for (const blk of blocks) {
              extractImages(blk?.content?.creation_block?.creations)
            }
          }
          const pv = op?.patch_value
          if (pv) {
            const mid = String(pv.message_id || pv.msg_id || '').trim()
            if (mid && mid !== '0') {
              const vid = findVid(pv)
              if (vid && !videoDb.has(mid)) {
                videoDb.set(mid, vid)
                dbg('videoDb stored (patch):', mid, '→', vid)
                post({ type: '__DF_videoFound', messageId: mid, vid })
              }
            }
          }
        }
      }

      // dola.com 通用路径 — 深度搜索含 message_id + vid 的节点
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        const mid = String(node.message_id || node.msg_id || node.messageId || '').trim()
        if (mid && mid !== '0' && !videoDb.has(mid)) {
          const vid = findVid(node)
          if (vid) {
            videoDb.set(mid, vid)
            dbg('videoDb stored (deep):', mid, '→', vid)
            post({ type: '__DF_videoFound', messageId: mid, vid })
          }
        }
        // 搜索视频URL — 查找包含视频播放地址的节点
        const vid2 = node.vid || node.video_id || node.video_key || node.video_vid
        if (typeof vid2 === 'string' && vid2.length > 5) {
          captureVideoUrls(vid2, node)
        }
      }
    })
  } catch (_) {}
}

// 从API响应节点中捕获视频URL
function captureVideoUrls(vid, node) {
  dbg('Video API Node for vid:', vid, node)
  dbg('Video API Node Full Data:', JSON.parse(JSON.stringify(node)))
  // 查找各种可能的视频URL字段
  const directCandidates = [
    { key: 'main_url', source: 'original_media_info', url: node.original_media_info?.main_url, width: node.original_media_info?.width, height: node.original_media_info?.height },
    { key: 'main_url', source: 'original_media_info', url: node.original_media_info?.main_url, width: node.original_media_info?.meta?.width, height: node.original_media_info?.meta?.height },
    { key: 'no_watermark_url', source: 'node', url: node.no_watermark_url, width: node.width || node.video_width, height: node.height || node.video_height },
    { key: 'original_url', source: 'node', url: node.original_url, width: node.width || node.video_width, height: node.height || node.video_height },
    { key: 'main_url', source: 'node', url: node.main_url, width: node.width || node.video_width, height: node.height || node.video_height },
    { key: 'play_url', source: 'node', url: node.play_url, width: node.width || node.video_width, height: node.height || node.video_height },
    { key: 'download_url', source: 'node', url: node.download_url, width: node.width || node.video_width, height: node.height || node.video_height },
    { key: 'video_url', source: 'node', url: node.video_url, width: node.width || node.video_width, height: node.height || node.video_height },
    { key: 'url', source: 'node', url: node.url, width: node.width || node.video_width, height: node.height || node.video_height },
    { key: 'src', source: 'node', url: node.src, width: node.width || node.video_width, height: node.height || node.video_height },
    { key: 'mp4_url', source: 'node', url: node.mp4_url, width: node.width || node.video_width, height: node.height || node.video_height },
    { key: 'hls_url', source: 'node', url: node.hls_url, width: node.width || node.video_width, height: node.height || node.video_height },
    // 嵌套结构
    { key: 'main', source: 'play_info', url: node.play_info?.main, width: node.play_info?.width, height: node.play_info?.height },
    { key: 'main_url', source: 'play_info', url: node.play_info?.main_url, width: node.play_info?.width, height: node.play_info?.height },
    { key: 'main_url', source: 'video', url: node.video?.main_url, width: node.video?.width, height: node.video?.height },
    { key: 'play_url', source: 'video', url: node.video?.play_url, width: node.video?.width, height: node.video?.height },
    { key: 'url', source: 'video', url: node.video?.url, width: node.video?.width, height: node.video?.height },
    { key: 'main_url', source: 'media_info', url: node.media_info?.main_url, width: node.media_info?.width, height: node.media_info?.height }
  ]
  rememberVideoUrl(vid, directCandidates)

  // 也递归搜索子对象
  for (const val of Object.values(node)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const nestedCandidates = [
        { key: 'no_watermark_url', source: 'nested', url: val.no_watermark_url, width: val.width, height: val.height },
        { key: 'original_url', source: 'nested', url: val.original_url, width: val.width, height: val.height },
        { key: 'main_url', source: 'nested', url: val.main_url, width: val.width, height: val.height },
        { key: 'play_url', source: 'nested', url: val.play_url, width: val.width, height: val.height },
        { key: 'download_url', source: 'nested', url: val.download_url, width: val.width, height: val.height },
        { key: 'url', source: 'nested', url: val.url, width: val.width, height: val.height }
      ].filter(item => typeof item.url === 'string' && item.url.startsWith('http') && (item.url.includes('video') || item.url.includes('.mp4') || item.url.includes('media')))
      rememberVideoUrl(vid, nestedCandidates)
    }
  }
}

function extractImagesFromMessages(msgs) {
  if (!Array.isArray(msgs)) return
  for (const msg of msgs) {
    const blocks = msg?.content_block
    if (Array.isArray(blocks)) {
      for (const blk of blocks) {
        extractImages(blk?.content?.creation_block?.creations)
      }
    }
  }
}

function post(data) {
  window.postMessage(data, '*')
}

// ============================================================
//  1. Hook JSON.parse
// ============================================================
JSON.parse = function(...args) {
  const r = _parse(...args)
  try { harvest(r) } catch (_) {}
  return r
}

// ============================================================
//  2. Hook fetch
// ============================================================
window.fetch = function(input, init) {
  const reqUrl  = typeof input === 'string' ? input : input?.url
  const reqInit = init || (typeof input === 'object' ? input : undefined)

  // 15秒模式：修改请求体 duration
  if (mode15s && reqInit?.body && typeof reqInit.body === 'string') {
    try {
      const parsed = JSON.parse(reqInit.body)
      if (patchDuration(parsed)) {
        reqInit.body = JSON.stringify(parsed)
      }
    } catch (_) {}
  }

  return _fetch(input, reqInit).then(async resp => {
    if (!resp.ok) return resp
    const ct = resp.headers?.get?.('content-type') || ''
    if (ct.includes('text/event-stream') || ct.includes('application/json')) {
      const body = resp.body
      if (!body) return resp
      const [a, b] = body.tee()
      consumeStream(b, ct)
      return new Response(a, { status: resp.status, statusText: resp.statusText, headers: resp.headers })
    }
    return resp
  }).catch(() => _fetch(input, reqInit))
}

async function consumeStream(stream, ct) {
  if (ct.includes('text/event-stream')) {
    await consumeSSE(stream)
  } else {
    // JSON — 读完整段
    try {
      const reader = stream.getReader()
      const dec = new TextDecoder()
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += dec.decode(value, { stream: true })
      }
      text += dec.decode()
      try { harvest(JSON.parse(text)) } catch(_) {}
    } catch(_) {}
  }
}

async function consumeSSE(stream) {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() || ''
      for (const part of parts) {
        const m = part.match(/^data: (.+)$/m)
        if (m) try { harvest(JSON.parse(m[1])) } catch(_) {}
      }
    }
  } catch(_) {}
}

// ============================================================
//  3. Hook XHR
// ============================================================
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  this.__df_url = typeof url === 'string' ? url : String(url)
  return _xhrOpen.call(this, method, url, ...rest)
}
XMLHttpRequest.prototype.send = function(...args) {
  this.addEventListener('load', () => {
    const u = this.__df_url
    if (!u || !u.includes('chain/single')) return
    try { harvest(JSON.parse(this.responseText)) } catch(_) {}
  })
  return _xhrSend.apply(this, args)
}

// ============================================================
//  4. 捕获 SPA 导航
// ============================================================
history.pushState = function(...args) {
  _pushState.apply(this, args)
  setTimeout(scanDOM, 1000)
}
// 尝试将视频URL转为无水印版本
function makeNoWatermarkUrl(videoUrl) {
  if (!videoUrl) return videoUrl
  let url = videoUrl
  // 策略1: 替换 lr= 参数（doubao.com CDN）
  if (url.includes('lr=')) {
    url = url.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark')
  }
  // 策略2: 替换/移除 watermark 相关参数
  if (url.includes('watermark')) {
    // 尝试将 watermark=1 改为 watermark=0
    url = url.replace(/watermark=1/g, 'watermark=0')
    // 尝试去掉 ~tplv-*watermark* 后缀（字节CDN的图片/视频处理标记）
    url = url.replace(/~tplv-[^.?&]*watermark[^.?&]*/gi, '')
  }
  // 策略3: 去掉 logo 参数
  if (url.includes('logo=')) {
    url = url.replace(/[&?]logo=[^&]*/g, '')
  }
  return url
}

async function resolveVideoUrl(vid) {
  dbg('resolveVideoUrl called with vid:', vid)

  // 根据域名选择正确的 app ID
  const aid = location.hostname.includes('dola.com') ? '489823' : '497858'
  // 优先实时调用 get_play_info，页面中缓存到的播放源经常是带水印的展示流
  try {
    const url = location.origin + '/samantha/media/get_play_info?aid=' + aid + '&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version&web_tab_id=' + crypto.randomUUID()
    const resp = await _fetch(url, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'origin': location.origin,
        'referer': location.href
      },
      credentials: 'include',
      body: JSON.stringify({ key: vid, type: 'video' })
    })
    const j = await resp.json()
    dbg('get_play_info response:', JSON.stringify(j).substring(0, 500))
    if (j.code === 0 && j.data) {
      const candidates = []

      // original_media_info 通常是后端原始无水印版本
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

      // 备选：从 play_infos / play_info 中选最像无水印的播放地址
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

      // 备选2：遍历 data 中所有可能的视频URL
      walkJSON(j.data, node => {
        if (typeof node !== 'object' || node === null) return
        const width = node.width || node.video_width || node.meta?.width || null
        const height = node.height || node.video_height || node.meta?.height || null
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'string' && v.startsWith('http') && (v.includes('.mp4') || v.includes('video') || v.includes('media'))) {
            candidates.push({ key: k, source: 'api_walk', url: v, width, height })
          }
        }
      })

      const best = chooseBestVideoUrl(candidates)
      if (best) {
        rememberVideoUrl(vid, [best])
        dbg('Using get_play_info URL:', best.key, best.source, 'score=', best.score, best.url.substring(0, 200))
        return {
          mainUrl: makeNoWatermarkUrl(best.url),
          width: best.width || null,
          height: best.height || null
        }
      }
    }
  } catch (e) { dbg('resolveVideoUrl error:', e.message) }

  // 尝试通过 forwarder 跨域调用 doubao.com / dola.com API 获取原始无水印地址
  const bgResult = await new Promise(resolve => {
    const listener = (e) => {
      const msg = e.data
      if (msg && msg.type === '__DF_videoUrlBack' && msg.vid === vid) {
        window.removeEventListener('message', listener)
        resolve(msg.result)
      }
    }
    window.addEventListener('message', listener)
    window.postMessage({ type: '__DF_getVideoUrl', vid: vid }, '*')
    
    // 超时防止死锁
    setTimeout(() => {
      window.removeEventListener('message', listener)
      resolve(null)
    }, 5000)
  })
  
  if (bgResult && bgResult.mainUrl) {
    dbg('Using background fallback URL:', bgResult.mainUrl.substring(0, 150))
    return bgResult
  }

  // API 不可用时再使用页面响应中捕获的候选地址兜底
  if (videoUrlDb.has(vid)) {
    const cached = videoUrlDb.get(vid)
    dbg('Using cached video URL from videoUrlDb:', cached.mainUrl.substring(0, 150))
    // 即使是水印版本，如果没有更好的，还是返回吧，不过可以通过分数或者正则过滤掉实在不想要的
    if (isLikelyWatermarkedUrl(cached.mainUrl, 'cached video')) {
      dbg('Cached URL is likely watermarked, returning it anyway as last resort')
    }
    return {
      mainUrl: makeNoWatermarkUrl(cached.mainUrl),
      width: cached.width,
      height: cached.height
    }
  }

  return null
}

async function resolveVideoUrlForElement(vid, videoEl = null) {
  let result = vid ? await resolveVideoUrl(vid) : null
  if (isAcceptableVideoResult(result)) return result

  const currentUrl = videoEl?.currentSrc || videoEl?.src || videoEl?.querySelector?.('source')?.src
  const metaVid = await extractVidFromVideoUrl(currentUrl)
  if (metaVid && metaVid !== vid) {
    dbg('Extracted vid from MP4 metadata:', metaVid)
    result = await resolveVideoUrl(metaVid)
    if (isAcceptableVideoResult(result)) return result
  }

  return null
}

// ============================================================
//  6. DOM 注入
// ============================================================

const SVG_DL = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'

function injectStyles() {
  if (document.getElementById('__df_styles')) return
  const s = document.createElement('style')
  s.id = '__df_styles'
  s.textContent = `
.__df-btn{position:absolute!important;bottom:10px!important;right:10px!important;z-index:99999!important;display:inline-flex!important;align-items:center!important;gap:5px!important;padding:6px 12px!important;background:rgba(0,0,0,0.62)!important;color:#fff!important;border:none!important;border-radius:8px!important;font-size:12px!important;font-weight:500!important;cursor:pointer!important;backdrop-filter:blur(6px)!important;-webkit-backdrop-filter:blur(6px)!important;transition:background .2s,transform .15s!important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif!important;line-height:1!important;white-space:nowrap!important;pointer-events:all!important;user-select:none!important}
.__df-btn:hover{background:rgba(0,0,0,0.82)!important}
.__df-btn:active{transform:scale(.97)!important}
.__df-btn.__df-ok{background:rgba(16,185,129,0.85)!important}
.__df-btn.__df-fail{background:rgba(239,68,68,0.82)!important}
`
  ;(document.head || document.documentElement).appendChild(s)
}

// 为每张图片找到其独立的包裹容器（而非共享的 message 容器）
// 策略：从图片向上找到第一个尺寸合适且只包含当前图片的容器
function findContainer(imgEl) {
  let c = imgEl.parentElement
  // 向上查找，但要确保找到的是图片的独立容器，而非所有图片共享的父容器
  for (let i = 0; i < 8 && c && c !== document.body; i++) {
    const r = c.getBoundingClientRect()
    // 找到一个尺寸合适的容器就停止
    if (r.width >= 80 && r.height >= 60) {
      // 检查这个容器是否包含多张 AI 生成的图片
      // 如果包含多张，说明是共享容器，应该使用更内层的包裹
      const imgs = c.querySelectorAll('img')
      const aiImgs = Array.from(imgs).filter(img => img.src && img.src.startsWith('http') && img.naturalWidth > 50)
      if (aiImgs.length <= 1) {
        // 独立容器，可以使用
        break
      }
      // 如果包含多张图片但当前容器刚好是图片的直接父级，也可以用
      if (c === imgEl.parentElement) break
      // 否则回退到图片的直接父级
      return imgEl.parentElement
    }
    c = c.parentElement
  }
  return c || imgEl.parentElement
}

function ensureRelative(el) {
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
}

// 查找图片对应的无水印数据
function findImageData(imgSrc) {
  // 方法1: 通过 rc_gen_image key 在 imageDb 中查找
  const rcKey = extractFileKey(imgSrc)
  if (rcKey) {
    const data = imageDb.get(rcKey)
    if (data) { dbg('findImageData matched via rc_key:', rcKey); return data }
  }
  // 方法2: 通过所有可能的 key 在 imageUrlMap 中精确查找
  const keys = extractAllKeys(imgSrc)
  for (const key of keys) {
    const data = imageUrlMap.get(key)
    if (data) { dbg('findImageData matched via key:', key); return data }
  }
  // 方法3: hash 子串匹配 — 提取 img src 中的32位hex hash，在 imageUrlMap 中搜索
  const srcHash = extractHash(imgSrc)
  if (srcHash) {
    for (const [key, data] of imageUrlMap) {
      if (key.includes(srcHash) || srcHash.includes(key)) {
        dbg('findImageData matched via hash:', srcHash, '↔', key)
        return data
      }
    }
  }
  // 方法4: 暴力匹配 — 遍历 imageUrlMap 看有无URL片段互相包含
  try {
    const srcPath = new URL(imgSrc).pathname
    const srcFile = srcPath.split('/').pop().split('~')[0].split('?')[0]
    for (const [key, data] of imageUrlMap) {
      if (srcPath.includes(key) || key.includes(srcFile)) {
        dbg('findImageData matched via brute-force:', srcFile, '↔', key)
        return data
      }
    }
  } catch (_) {}
  return null
}


// 图片下载按钮
function tryInjectImage(imgEl) {
  if (imgEl.__df_img) return
  imgEl.__df_img = true
  
  const data = findImageData(imgEl.src)
  if (!data) {
    dbg('No data found for img:', imgEl.src)
    // 标记等待，后续scanDOM重试
    imgEl.__df_img = false
    imgEl.__df_waitRetry = (imgEl.__df_waitRetry || 0) + 1
    if (imgEl.__df_waitRetry > 20) imgEl.__df_img = true // 超过20次放弃
    return
  }

  dbg('Injecting download button for img:', imgEl.src)

  const container = findContainer(imgEl)
  ensureRelative(container)

  const btn = document.createElement('button')
  btn.className = '__df-btn'
  btn.innerHTML = SVG_DL + ' 下载原图'

  // 阻止 mousedown/pointerdown 冒泡（防止预览窗口关闭），但不用 stopImmediate
  function stopBubble(e) {
    e.stopPropagation()
    e.preventDefault()
  }
  btn.addEventListener('mousedown', stopBubble, true)
  btn.addEventListener('mouseup', stopBubble, true)
  btn.addEventListener('pointerdown', stopBubble, true)
  btn.addEventListener('pointerup', stopBubble, true)

  btn.addEventListener('click', e => {
    e.stopPropagation()
    e.stopImmediatePropagation()
    e.preventDefault()
    if (btn.disabled) return
    btn.disabled = true; btn.textContent = '下载中…'
    const prefix = location.hostname.includes('dola.com') ? 'dola_img_' : 'doubao_img_'
    const fn = prefix + (data.width && data.height ? data.width + 'x' + data.height + '_' : '') + Date.now() + '.png'
    post({ type: '__DF_download', url: data.no_watermark_url, filename: fn, __cbId: Date.now() + '_' + Math.random().toString(36).slice(2, 6) })
    // 下载成功反馈
    setTimeout(() => {
      btn.disabled = false
      btn.innerHTML = '✓ 已下载'
      btn.classList.add('__df-ok')
      setTimeout(() => { btn.innerHTML = SVG_DL + ' 下载原图'; btn.classList.remove('__df-ok') }, 2000)
    }, 500)
  })
  container.appendChild(btn)
}

// 视频下载按钮
function tryInjectVideo(el) {
  if (el.__df_video) return
  el.__df_video = true

  // 查找 messageId
  let cur = el
  for (let i = 0; i < 20 && cur && cur !== document.body; i++) {
    if (cur.dataset?.messageId) break
    if (cur.dataset?.message_id) break
    cur = cur.parentElement
  }
  const mid = cur?.dataset?.messageId || cur?.dataset?.message_id
  if (!mid) return

  // 如果还没拿到vid，标记等待
  if (!videoDb.has(mid)) {
    el.__df_waitMid = mid
    return
  }

  ensureRelative(el)

  const btn = document.createElement('button')
  btn.className = '__df-btn'
  btn.innerHTML = SVG_DL + ' 下载无水印视频'

  let downloading = false
  btn.onclick = async e => {
    e.stopPropagation()
    if (downloading) return
    downloading = true
    btn.disabled = true; btn.textContent = '获取链接…'

    const vid = videoDb.get(mid)
    if (!vid) { btn.disabled = false; btn.textContent = '无视频'; downloading = false; return }

    const result = await resolveVideoUrlForElement(vid, el.querySelector?.('video'))
    if (!result?.mainUrl) {
      btn.disabled = false; btn.innerHTML = SVG_DL + ' 下载无水印视频'
      showToast('获取视频链接失败', 'fail')
      downloading = false
      return
    }

    const prefix = location.hostname.includes('dola.com') ? 'dola_video_' : 'doubao_video_'
    const fn = prefix + (result.width && result.height ? result.width + 'x' + result.height + '_' : '') + Date.now() + '.mp4'
    post({ type: '__DF_download', url: result.mainUrl, filename: fn, __cbId: 'v_' + Date.now() })
    // 结果由消息监听处理
    downloading = false
    btn.disabled = false
    btn.innerHTML = '✓ 已发送下载'
    btn.classList.add('__df-ok')
    setTimeout(() => { btn.innerHTML = SVG_DL + ' 下载无水印视频'; btn.classList.remove('__df-ok') }, 2500)
  }

  el.appendChild(btn)
}

function showToast(msg, type) {
  const t = document.createElement('div')
  t.style.cssText = 'position:fixed;bottom:20px;right:20px;background:' + (type === 'ok' ? '#10b981' : '#ef4444') + ';color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:100001;font-family:system-ui;box-shadow:0 4px 12px rgba(0,0,0,0.15);animation:__df_fade 2.5s ease forwards'
  t.textContent = (type === 'ok' ? '✓ ' : '⚠️ ') + msg
  if (!document.body) return
  document.body.appendChild(t)
  if (!document.getElementById('__df_toast_style')) {
    const s = document.createElement('style')
    s.id = '__df_toast_style'
    s.textContent = '@keyframes __df_fade{0%{opacity:0;transform:translateY(10px)}15%{opacity:1;transform:translateY(0)}85%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(10px);visibility:hidden}}'
    ;(document.head || document.documentElement).appendChild(s)
  }
  setTimeout(() => { if (t.parentNode) t.remove() }, 2600)
}

// ============================================================
//  DOM 扫描
// ============================================================
function scanDOM() {
  try {
    // 策略1: doubao.com 原始选择器 — img src 包含 rc_gen_image
    document.querySelectorAll('img[src*="rc_gen_image"]').forEach(tryInjectImage)

    // 策略2: dola.com / 通用 — 查找 creation 相关容器内的图片
    // 豆包/dola 的图片生成结果通常在 class 包含 "creation" 的容器中
    document.querySelectorAll('[class*="creation"] img, [class*="Creation"] img').forEach(imgEl => {
      if (imgEl.__df_img && imgEl.__df_waitRetry === undefined) return
      if (imgEl.src && imgEl.src.startsWith('http') && imgEl.naturalWidth > 50) {
        tryInjectImage(imgEl)
      }
    })

    // 策略3: 通用 — 在 imageUrlMap 中有数据时，扫描所有大尺寸图片
    if (imageUrlMap.size > 0) {
      document.querySelectorAll('img').forEach(imgEl => {
        if (imgEl.__df_img) return
        if (imgEl.__df_skip) return  // 已确认非AI图片，跳过
        if (!imgEl.src || !imgEl.src.startsWith('http')) return
        // 排除明显的静态资源和UI图片
        if (imgEl.src.includes('/static/') || imgEl.src.includes('/dola_web/') || 
            imgEl.src.includes('/icon') || imgEl.src.includes('/logo') ||
            imgEl.src.includes('/avatar') || imgEl.src.includes('/emoji') ||
            imgEl.src.includes('data:image') || imgEl.src.includes('/sam/')) {
          imgEl.__df_skip = true
          return
        }
        // 放宽尺寸限制，有些图片可能刚加载还没渲染完
        if (imgEl.naturalWidth < 50) return
        // 排除明显的小图标和UI元素
        if (imgEl.width < 60 && imgEl.height < 60) return
        // 检查是否能在我们的数据库中找到匹配
        const data = findImageData(imgEl.src)
        if (data) {
          tryInjectImage(imgEl)
        } else {
          // 标记已检查次数，避免反复日志
          imgEl.__df_scanCount = (imgEl.__df_scanCount || 0) + 1
          if (imgEl.__df_scanCount >= 5) {
            imgEl.__df_skip = true  // 检查5次仍无匹配，标记跳过
          }
        }
      })
    }

    // ====== 视频策略 ======

    // 策略V1（旧）: 通过 class 名查找视频容器 + videoDb
    document.querySelectorAll('[class*="block-video"], [class*="video-block"], [class*="video_block"], [class*="VideoBlock"], [class*="video-container"], [class*="video-wrapper"]').forEach(tryInjectVideo)
    
    // 二次扫描等待中的视频
    document.querySelectorAll('[class*="block-video"], [class*="video-block"], [class*="video_block"], [class*="VideoBlock"], [class*="video-container"], [class*="video-wrapper"]').forEach(el => {
      if (el.__df_video) return
      if (el.__df_waitMid && videoDb.has(el.__df_waitMid)) {
        tryInjectVideo(el)
      }
    })

    // 策略V2（新）: 直接查找 <video> 元素，从 src/currentSrc 获取视频URL
    document.querySelectorAll('video').forEach(videoEl => {
      if (videoEl.__df_videoDirectDone) return
      const videoSrc = videoEl.currentSrc || videoEl.src || videoEl.querySelector('source')?.src
      if (!videoSrc || videoSrc.startsWith('blob:')) {
        return
      }
      videoEl.__df_videoDirectDone = true

      // 找一个合适的容器放按钮
      let container = videoEl.parentElement
      for (let i = 0; i < 6 && container && container !== document.body; i++) {
        const r = container.getBoundingClientRect()
        if (r.width >= 100 && r.height >= 80) break
        container = container.parentElement
      }
      if (!container) return
      ensureRelative(container)

      const blockContainer = videoEl.closest?.('[class*="block-video"], [class*="video-block"], [class*="video_block"], [class*="VideoBlock"], [class*="video-container"], [class*="video-wrapper"]')
      if (blockContainer?.querySelector?.('.__df-btn')) {
        videoEl.__df_videoDirectDone = true
        return
      }

      const btn = document.createElement('button')
      btn.className = '__df-btn'
      btn.innerHTML = SVG_DL + ' 下载无水印视频'
      
      function stopBubbleV(e) { e.stopPropagation(); e.preventDefault() }
      btn.addEventListener('mousedown', stopBubbleV, true)
      btn.addEventListener('pointerdown', stopBubbleV, true)
      
      btn.addEventListener('click', async e => {
        e.stopPropagation()
        e.stopImmediatePropagation()
        e.preventDefault()
        if (btn.disabled) return
        btn.disabled = true; btn.textContent = '获取无水印链接…'

        // 尝试找到 vid：从父级容器的 data 属性、或 videoDb 中查找
        let vid = null
        let cur = videoEl
        for (let i = 0; i < 20 && cur && cur !== document.body; i++) {
          const mid = cur.dataset?.messageId || cur.dataset?.message_id
          if (mid && videoDb.has(mid)) {
            vid = videoDb.get(mid)
            dbg('Found vid from DOM messageId:', mid, '→', vid)
            break
          }
          cur = cur.parentElement
        }

        // 如果找到 vid，尝试通过 API 获取无水印视频
        if (vid) {
          dbg('Trying get_play_info with vid:', vid)
          const result = await resolveVideoUrlForElement(vid, videoEl)
          if (result?.mainUrl) {
            dbg('API returned no-watermark URL:', result.mainUrl.substring(0, 150))
            const prefix = location.hostname.includes('dola.com') ? 'dola_video_' : 'doubao_video_'
            const fn = prefix + (result.width && result.height ? result.width + 'x' + result.height + '_' : '') + Date.now() + '.mp4'
            post({ type: '__DF_download', url: result.mainUrl, filename: fn, __cbId: 'vd_' + Date.now() })
            btn.disabled = false
            btn.innerHTML = '✓ 已发送下载'
            btn.classList.add('__df-ok')
            setTimeout(() => { btn.innerHTML = SVG_DL + ' 下载无水印视频'; btn.classList.remove('__df-ok') }, 2500)
            return
          }
        }

        // 如果没有 vid 或 API 失败，也尝试在所有 videoDb 中找最新的 vid
        if (!vid && videoDb.size > 0) {
          const lastVid = Array.from(videoDb.values()).pop()
          dbg('Trying last vid from videoDb:', lastVid)
          const result = await resolveVideoUrlForElement(lastVid, videoEl)
          if (result?.mainUrl) {
            const prefix = location.hostname.includes('dola.com') ? 'dola_video_' : 'doubao_video_'
            const fn = prefix + Date.now() + '.mp4'
            post({ type: '__DF_download', url: result.mainUrl, filename: fn, __cbId: 'vd_' + Date.now() })
            btn.disabled = false
            btn.innerHTML = '✓ 已发送下载'
            btn.classList.add('__df-ok')
            setTimeout(() => { btn.innerHTML = SVG_DL + ' 下载无水印视频'; btn.classList.remove('__df-ok') }, 2500)
            return
          }
        }

        btn.disabled = false
        btn.innerHTML = '未找到无水印链接'
        btn.classList.add('__df-fail')
        setTimeout(() => { btn.innerHTML = SVG_DL + ' 下载无水印视频'; btn.classList.remove('__df-fail') }, 3000)
      })
      container.appendChild(btn)
      dbg('Injected direct video download button')
    })
  } catch (_) {}
}

function startObserver() {
  injectStyles()
  setTimeout(scanDOM, 500)

  const obs = new MutationObserver(() => setTimeout(scanDOM, 200))
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })

  setInterval(scanDOM, 3000)
}

// ============================================================
//  消息监听
// ============================================================
window.addEventListener('message', e => {
  const d = e.data
  if (!d) return
  switch (d.type) {
    case '__DF_modeChanged':
      mode15s = d.value
      showToast(d.value ? '15秒模式已开启' : '15秒模式已关闭', 'ok')
      break
    case '__DF_downloadResult':
      // 下载结果通知（来自 forwarder）
      break
  }
})

// ============================================================
//  启动
// ============================================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObserver)
} else {
  startObserver()
}
