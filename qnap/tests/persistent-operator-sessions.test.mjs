import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PersistentOperatorSessions } from '../patches/persistent-operator-sessions.mjs'

const DAY = 86400000
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'motrix-session-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let at = 1700000000000
  return {
    directory,
    now: () => at,
    advance: (n) => {
      at += n
    },
    id: randomBytes(32).toString('base64url'),
    token: 'test-operator-token-only',
    file: path.join(directory, 'operator-sessions.json'),
  }
}
test('successful login survives a new server instance without storing raw credentials', (t) => {
  const f = fixture(t)
  const store = new PersistentOperatorSessions(f.token, f)
  store.set(f.id, f.now() + 365 * DAY)
  const restored = new PersistentOperatorSessions(f.token, f)
  assert.equal(restored.get(f.id), f.now() + 365 * DAY)
  const content = readFileSync(f.file, 'utf8')
  assert.ok(!content.includes(f.id))
  assert.ok(!content.includes(f.token))
  JSON.parse(content)
  assert.equal(statSync(f.file).mode & 0o777, 0o600)
})
test('logout is durable across restart and leaves other browser sessions valid', (t) => {
  const f = fixture(t)
  let store = new PersistentOperatorSessions(f.token, f)
  const other = randomBytes(32).toString('base64url')
  store.set(f.id, f.now() + 365 * DAY)
  store.set(other, f.now() + 365 * DAY)
  assert.equal(store.delete(f.id), true)
  store = new PersistentOperatorSessions(f.token, f)
  assert.equal(store.get(f.id), undefined)
  assert.equal(store.get(other), f.now() + 365 * DAY)
})
test('rotating the operator token invalidates old browser sessions', (t) => {
  const f = fixture(t)
  const store = new PersistentOperatorSessions(f.token, f)
  store.set(f.id, f.now() + 365 * DAY)
  assert.equal(
    new PersistentOperatorSessions('rotated-token', f).get(f.id),
    undefined
  )
})
test('expired sessions are not restored and invalid cookies are never accepted', (t) => {
  const f = fixture(t)
  const store = new PersistentOperatorSessions(f.token, f)
  store.set(f.id, f.now() + DAY)
  f.advance(2 * DAY)
  assert.equal(new PersistentOperatorSessions(f.token, f).get(f.id), undefined)
  assert.equal(store.get('bad-cookie'), undefined)
})
test('polling renewals avoid a disk write on every request but eventually persist', (t) => {
  const f = fixture(t)
  const store = new PersistentOperatorSessions(f.token, f)
  store.set(f.id, f.now() + 365 * DAY)
  const original = readFileSync(f.file, 'utf8')
  f.advance(60000)
  store.set(f.id, f.now() + 365 * DAY)
  assert.equal(readFileSync(f.file, 'utf8'), original)
  f.advance(DAY)
  store.set(f.id, f.now() + 365 * DAY)
  assert.equal(
    new PersistentOperatorSessions(f.token, f).get(f.id),
    f.now() + 365 * DAY
  )
})
test('corrupt cache fails closed but a fresh valid login can replace it', (t) => {
  const f = fixture(t)
  writeFileSync(f.file, 'null')
  const store = new PersistentOperatorSessions(f.token, f)
  assert.equal(store.get(f.id), undefined)
  store.set(f.id, f.now() + 365 * DAY)
  assert.equal(
    new PersistentOperatorSessions(f.token, f).get(f.id),
    f.now() + 365 * DAY
  )
})
test('session storage refuses symlinks', (t) => {
  const f = fixture(t)
  const target = path.join(f.directory, 'other')
  writeFileSync(target, '{}')
  symlinkSync(target, f.file)
  assert.throws(
    () => new PersistentOperatorSessions(f.token, f),
    /regular file/
  )
  assert.equal(readFileSync(target, 'utf8'), '{}')
})
