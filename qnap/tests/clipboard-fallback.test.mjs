import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(
  new URL('../patches/clipboard-fallback.js', import.meta.url),
  'utf8'
)
function setup({
  clipboard,
  permitted = true,
  throws = false,
  modal = false,
} = {}) {
  const state = { removed: false, focused: false, restored: false, copies: 0 }
  const range = { cloneRange: () => range }
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: () => {},
    addRange: (value) => {
      state.restored = value === range
    },
  }
  const parent = {
    appendChild: (field) => {
      state.field = field
    },
  }
  const document = {
    activeElement: {
      closest: () => (modal ? parent : null),
      focus: () => {
        state.focused = true
      },
    },
    getSelection: () => selection,
    body: modal
      ? {
          appendChild: () => {
            throw new Error('Modal focus must stay inside dialog')
          },
        }
      : parent,
    createElement: () => ({
      style: {},
      setAttribute: () => {},
      focus: () => {},
      select: () => {},
      setSelectionRange: () => {},
      remove: () => {
        state.removed = true
      },
    }),
    execCommand: (command) => {
      assert.equal(command, 'copy')
      state.copies++
      if (throws) throw new Error('blocked')
      return permitted
    },
  }
  const navigator = clipboard ? { clipboard } : {}
  runInNewContext(source, { navigator, document })
  return { navigator, state }
}

test('missing Clipboard API supports multiline text and restores focus and selection', async () => {
  const { navigator, state } = setup()
  await navigator.clipboard.writeText('line one\n第二行')
  assert.equal(state.field.value, 'line one\n第二行')
  assert.equal(state.copies, 1)
  assert.ok(state.removed && state.focused && state.restored)
})
test('native secure-context clipboard remains untouched', async () => {
  const clipboard = { writeText: async () => 'native' }
  const { navigator, state } = setup({ clipboard })
  assert.equal(navigator.clipboard, clipboard)
  assert.equal(await navigator.clipboard.writeText('hello'), 'native')
  assert.equal(state.copies, 0)
})
test('fallback stays inside a modal dialog', async () => {
  const { navigator, state } = setup({ modal: true })
  await navigator.clipboard.writeText('inside dialog')
  assert.ok(state.removed && state.focused)
})
test('browser refusal rejects instead of reporting a successful copy', async () => {
  const { navigator, state } = setup({ permitted: false })
  await assert.rejects(
    navigator.clipboard.writeText('blocked'),
    /not permitted/
  )
  assert.ok(state.removed && state.focused && state.restored)
})
test('browser exceptions still remove the temporary text field', async () => {
  const { navigator, state } = setup({ throws: true })
  await assert.rejects(navigator.clipboard.writeText('blocked'), /blocked/)
  assert.ok(state.removed && state.focused && state.restored)
})
