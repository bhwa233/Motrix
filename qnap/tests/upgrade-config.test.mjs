import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const routines = fileURLToPath(
  new URL('../qpkg/package_routines', import.meta.url)
)
function upgrade({ saved, current, defaults = 'PORT=16880\n' }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'motrix-upgrade-'))
  try {
    for (const name of ['etc', 'bin', 'libexec'])
      mkdirSync(path.join(root, name))
    for (const name of [
      'MotrixServer.sh',
      'bin/node',
      'libexec/run-server.sh',
    ]) {
      writeFileSync(path.join(root, name), '#!/bin/sh\nexit 0\n')
      chmodSync(path.join(root, name), 0o755)
    }
    if (saved) writeFileSync(path.join(root, 'etc/motrix.conf.qdksave'), saved)
    if (current) writeFileSync(path.join(root, 'etc/motrix.conf'), current)
    const script = `set -eu
SYS_QPKG_DIR="$1"
. "$2"
err_log() { echo "$1" >&2; exit 1; }
pkg_pre_install
if [ ! -f "$SYS_QPKG_DIR/etc/motrix.conf" ]; then
  printf '%s' "$3" > "$SYS_QPKG_DIR/etc/motrix.conf"
fi
pkg_post_install
`
    const result = spawnSync(
      'sh',
      ['-c', script, 'upgrade-test', root, routines, defaults],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 0, result.stderr)
    return readFileSync(path.join(root, 'etc/motrix.conf'), 'utf8')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('restore custom settings moved aside by the current QDK transaction', () => {
  const settings = 'PORT=18080\nOPERATOR_TOKEN_FILE=/private/operator-token\n'
  assert.equal(upgrade({ saved: settings }), settings)
})
test('ignore stale qdksave when the active configuration still exists', () => {
  assert.equal(
    upgrade({ saved: 'PORT=11111\n', current: 'PORT=18080\n' }),
    'PORT=18080\n'
  )
})
test('fresh installation uses packaged defaults', () => {
  assert.equal(upgrade({}), 'PORT=16880\n')
})
