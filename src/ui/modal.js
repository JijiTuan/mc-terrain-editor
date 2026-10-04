/**
 * modal.js — 通用弹窗
 *
 * 由这里统一实现，toolbar / main 等都从这里引，避免出现循环依赖。
 */

export function openModal(app, opts) {
  const host = app.el.modalHost
  host.classList.remove('hidden')
  host.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <span>${opts.title ?? ''}</span>
        <div class="spacer"></div>
        <button class="ghost" data-close title="关闭">✕</button>
      </div>
      <div class="modal-body">${opts.body ?? ''}</div>
      ${opts.actions?.length ? `<div class="modal-foot">${opts.actions.map((a, i) =>
        `<button data-action="${i}" ${a.attr || ''} class="${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}">${a.label}</button>`
      ).join('')}</div>` : ''}
    </div>`

  const close = () => closeModal(app)

  host.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close))
  host.querySelectorAll('[data-action]').forEach((b) => {
    b.addEventListener('click', () => {
      const a = opts.actions[Number(b.dataset.action)]
      const keep = a.onClick?.()
      if (a.close !== false && keep !== false) close()
    })
  })
  // 点遮罩关闭；但带表单的弹窗容易误触，所以只在没有 actions 时启用
  if (!opts.actions?.length) {
    host.addEventListener('click', (e) => { if (e.target === host) close() })
  }

  opts.onOpen?.(host)
  return host
}

export function closeModal(app) {
  app.el.modalHost.classList.add('hidden')
  app.el.modalHost.innerHTML = ''
}
