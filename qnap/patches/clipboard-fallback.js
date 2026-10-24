// HTTP NAS origins do not expose the secure-context Clipboard API.
// Preserve the native implementation whenever it is available.
;(() => {
  if (typeof navigator.clipboard?.writeText === 'function') return

  const writeText = async (text) => {
    const active = document.activeElement
    const selection = document.getSelection()
    const ranges = []
    for (let i = 0; selection && i < selection.rangeCount; i++) {
      ranges.push(selection.getRangeAt(i).cloneRange())
    }
    const field = document.createElement('textarea')
    field.value = String(text)
    field.readOnly = true
    field.tabIndex = -1
    field.setAttribute('aria-hidden', 'true')
    field.style.cssText =
      'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
    const parent = active?.closest?.('[role="dialog"],dialog') ?? document.body
    parent.appendChild(field)
    try {
      field.focus({ preventScroll: true })
      field.select()
      field.setSelectionRange(0, field.value.length)
      if (!document.execCommand?.('copy')) {
        throw new Error('Clipboard copy was not permitted by the browser')
      }
    } finally {
      field.remove()
      active?.focus?.({ preventScroll: true })
      if (selection) {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
      }
    }
  }

  const clipboard = navigator.clipboard ?? {}
  Object.defineProperty(clipboard, 'writeText', {
    value: writeText,
    configurable: true,
  })
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: clipboard,
      configurable: true,
    })
  }
})()
