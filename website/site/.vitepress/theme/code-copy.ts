const states = new Map<HTMLButtonElement, ReturnType<typeof setTimeout> | undefined>()
let generation = 0
let manualDialog: HTMLDialogElement | null = null

const choose = (en: string, zh: string) => document.body.dataset.lang === 'zh' ? zh : en

function feedback(button: HTMLButtonElement, state: string) {
  button.dataset.copyState = state
  button.disabled = state === 'copying'
  button.setAttribute('aria-busy', String(state === 'copying'))
  const label = state === 'copied' ? choose('Copied', '已复制')
    : state === 'copying' ? choose('Copying', '正在复制') : button.dataset.copyLabel || ''
  button.setAttribute('aria-label', label)
  button.title = label
  const status = button.parentElement?.querySelector('.code-copy-status')
  if (status) status.textContent = state === 'copied' ? choose('Copied to clipboard', '已复制到剪贴板')
    : state === 'failed' ? choose('Automatic copy failed. You can copy manually.', '自动复制未成功，可手动复制') : ''
}

// VitePress keeps the document alive across routes. Drop old timers, pending
// feedback and dialogs before the next article or language is rendered.
export function resetCodeCopies() {
  generation += 1
  for (const [button, timer] of states) {
    clearTimeout(timer)
    feedback(button, 'idle')
  }
  states.clear()
  manualDialog?.close()
  manualDialog?.remove()
  manualDialog = null
}

function showManualCopy(button: HTMLButtonElement, text: string) {
  if (manualDialog) {
    manualDialog.querySelector('textarea')?.focus()
    manualDialog.querySelector('textarea')?.select()
    return
  }
  const dialog = document.createElement('dialog')
  dialog.className = 'code-copy-dialog'
  dialog.setAttribute('aria-labelledby', 'code-copy-title')
  dialog.setAttribute('aria-describedby', 'code-copy-description')
  const title = document.createElement('h2')
  title.id = 'code-copy-title'
  title.textContent = choose('Copy manually', '请手动复制')
  const description = document.createElement('p')
  description.id = 'code-copy-description'
  description.textContent = choose('Could not write to the clipboard. Select the text below and press ⌘C or Ctrl+C.', '未能写入剪贴板。选中下面的原文，按 ⌘C 或 Ctrl+C。')
  const input = document.createElement('textarea')
  input.readOnly = true
  input.value = text
  input.setAttribute('aria-label', choose('Complete text to copy', '待复制的完整原文'))
  const actions = document.createElement('div')
  actions.className = 'code-copy-dialog-actions'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'button button-quiet'
  close.textContent = choose('Close', '关闭')
  close.onclick = () => dialog.close()
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'button button-quiet'
  retry.textContent = choose('Retry copy', '重试复制')
  retry.onclick = async () => {
    retry.disabled = true
    await copyText(button, text)
    retry.disabled = false
  }
  actions.append(close, retry)
  dialog.append(title, description, input, actions)
  dialog.addEventListener('close', () => {
    if (manualDialog === dialog) manualDialog = null
    dialog.remove()
    if (button.isConnected) button.focus({ preventScroll: true })
  }, { once: true })
  document.body.append(dialog)
  manualDialog = dialog
  dialog.showModal()
  input.focus()
  input.select()
}

async function copyText(button: HTMLButtonElement, text: string) {
  if (button.disabled) return
  const current = generation
  clearTimeout(states.get(button))
  states.set(button, undefined)
  feedback(button, 'copying')
  let copied = false
  try {
    await navigator.clipboard.writeText(text)
    copied = true
  } catch { /* The manual dialog preserves the exact copy attempt. */ }
  if (current !== generation || !button.isConnected) return
  feedback(button, copied ? 'copied' : 'failed')
  if (copied) {
    manualDialog?.close()
    states.set(button, setTimeout(() => {
      feedback(button, 'idle')
      states.delete(button)
    }, 1800))
  } else {
    showManualCopy(button, text)
  }
}

export async function copyCode(button: HTMLButtonElement) {
  const source = button.closest('.doc-prompt')?.querySelector('pre')
  if (source) await copyText(button, source.textContent || '')
}
