import { copyCode } from './code-copy'

let installed = false

export function installInteractions() {
  if (installed) return
  installed = true

  document.addEventListener('click', async (event) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const copy = target.closest<HTMLButtonElement>('.prompt-copy')
    if (copy) {
      await copyCode(copy)
      return
    }

    const expand = target.closest<HTMLButtonElement>('[data-image]')
    if (expand) {
      const box = document.querySelector<HTMLDialogElement>('.lightbox')
      if (!box) return
      const img = new Image()
      img.src = expand.dataset.image || ''
      img.alt = expand.querySelector('img')?.alt || ''
      box.querySelector('.lightbox-media')?.replaceChildren(img)
      box.showModal()
      document.body.classList.add('modal-open')
      return
    }

    const close = target.closest('.lightbox .icon-button')
    if (close) document.querySelector<HTMLDialogElement>('.lightbox')?.close()
    if (target.matches('.lightbox')) (target as HTMLDialogElement).close()
  })

  document.addEventListener('close', (event) => {
    if ((event.target as Element)?.matches?.('.lightbox')) document.body.classList.remove('modal-open')
  }, true)

  document.addEventListener('change', (event) => {
    const select = event.target
    if (!(select instanceof HTMLSelectElement) || !select.closest('.mobile-doc-select')) return
    const lang = document.body.dataset.lang === 'zh' ? '/zh' : ''
    window.location.href = select.value === 'index' ? `${lang}/docs/` : `${lang}/docs/${select.value}.html`
  })
}
