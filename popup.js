/**
 * popup.js — 弹窗逻辑
 */

document.addEventListener('DOMContentLoaded', function () {
  const modeSwitch = document.getElementById('modeSwitch')
  const statusDot  = document.getElementById('statusDot')
  const statusText = document.getElementById('statusText')
  const imgCount   = document.getElementById('imgCount')
  const vidCount   = document.getElementById('vidCount')

  // ============================================================
  //  读取当前模式
  // ============================================================
  chrome.runtime.sendMessage({ type: '__DF_getMode' }, function (res) {
    if (res) {
      modeSwitch.checked = res.value === true
      updateStatus(res.value === true)
    }
  })

  // ============================================================
  //  切换模式
  // ============================================================
  modeSwitch.addEventListener('change', function () {
    const val = this.checked
    chrome.runtime.sendMessage({ type: '__DF_setMode', value: val }, function () {
      updateStatus(val)
    })
  })

  function updateStatus(on) {
    if (on) {
      statusDot.className = 'status-dot on'
      statusText.textContent = '15秒模式 · 已启用'
    } else {
      statusDot.className = 'status-dot off'
      statusText.textContent = '普通模式'
    }
  }

  // ============================================================
  //  检查当前 tab 是否为 doubao
  // ============================================================
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const tab = tabs[0]
    if (tab && tab.url && (tab.url.includes('doubao.com') || tab.url.includes('dola.com'))) {
      // 已连接
    } else {
      statusDot.className = 'status-dot off'
      statusText.textContent = '请打开 doubao.com 或 dola.com 使用'
    }
  })

  // ============================================================
  //  定时刷新统计信息
  // ============================================================
  // 通过 content script 获取数据（但因 MAIN world 限制，
  // 这里简化：只显示状态，不追踪实时数量）
  // 后续版本可扩展
})
