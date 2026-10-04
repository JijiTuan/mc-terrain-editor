/**
 * toast.js — 右下角轻提示
 */

const ICONS = { ok: '✓', error: '✕', warn: '!', info: 'i' }

export function showToast(host, message, level = 'info', duration = 3800) {
  if (!host) return
  const el = document.createElement('div')
  el.className = `toast ${level}`
  el.innerHTML = `<span style="opacity:.75;margin-right:6px">${ICONS[level] ?? 'i'}</span>${escapeHtml(message)}`
  host.appendChild(el)

  // 同类提示堆叠超过 4 条时，移除最旧的，避免刷屏
  while (host.children.length > 4) host.removeChild(host.firstChild)

  const remove = () => {
    el.style.transition = 'opacity .2s, transform .2s'
    el.style.opacity = '0'
    el.style.transform = 'translateX(16px)'
    setTimeout(() => el.remove(), 220)
  }
  const timer = setTimeout(remove, duration)
  el.addEventListener('click', () => { clearTimeout(timer); remove() })
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
