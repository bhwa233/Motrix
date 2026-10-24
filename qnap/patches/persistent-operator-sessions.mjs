import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const DAY = 86400000
const TTL = 365 * DAY
const MAX_SESSIONS = 128
const hash = (value) => createHash('sha256').update(value).digest('hex')
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id)

// Match the small Map interface used by upstream authentication. Persist only
// hashes of random session IDs, never the operator token or browser cookies.
export class PersistentOperatorSessions {
  constructor(
    operatorToken,
    { directory = process.env.MOTRIX_DATA_DIR, now = Date.now } = {}
  ) {
    if (!directory || !path.isAbsolute(directory))
      throw Error('Operator session data directory must be absolute')
    this.file = path.join(directory, 'operator-sessions.json')
    this.now = now
    this.fingerprint = hash(operatorToken)
    this.sessions = new Map()
    this.persisted = new Map()
    let content
    try {
      const info = lstatSync(this.file)
      if (!info.isFile() || info.isSymbolicLink())
        throw Error('Operator session storage must be a regular file')
      if (info.size > 1024 * 1024)
        throw Error('Operator session storage is too large')
      content = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch {
      return
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== 1 ||
      parsed.tokenFingerprint !== this.fingerprint ||
      !Array.isArray(parsed.sessions)
    )
      return
    const at = this.now()
    for (const entry of parsed.sessions.slice(-MAX_SESSIONS)) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const [digest, expiry] = entry
      if (
        typeof digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(digest) ||
        !Number.isSafeInteger(expiry) ||
        expiry <= at ||
        expiry > at + TTL + DAY
      )
        continue
      this.sessions.set(digest, expiry)
      this.persisted.set(digest, expiry)
    }
  }

  get(id) {
    return validId(id) ? this.sessions.get(hash(id)) : undefined
  }

  set(id, expiry) {
    if (!validId(id) || !Number.isSafeInteger(expiry))
      throw Error('Invalid operator session')
    const digest = hash(id)
    this.sessions.set(digest, expiry)
    // Upstream renews on every request. Avoid synchronous NAS writes for each
    // polling request; persist renewal at most once per 12 hours per session.
    if (
      !this.persisted.has(digest) ||
      expiry - this.persisted.get(digest) >= DAY / 2
    )
      this.save()
    return this
  }

  delete(id) {
    if (!validId(id)) return false
    const removed = this.sessions.delete(hash(id))
    if (removed) this.save()
    return removed
  }

  save() {
    const at = this.now()
    for (const [digest, expiry] of this.sessions)
      if (expiry <= at) this.sessions.delete(digest)
    while (this.sessions.size > MAX_SESSIONS)
      this.sessions.delete(this.sessions.keys().next().value)
    const content =
      JSON.stringify({
        version: 1,
        tokenFingerprint: this.fingerprint,
        sessions: [...this.sessions],
      }) + '\n'
    const temporary = path.join(
      path.dirname(this.file),
      '.operator-sessions-' + randomBytes(12).toString('hex') + '.tmp'
    )
    let fd
    let failure
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, this.file)
      this.persisted = new Map(this.sessions)
    } catch (error) {
      failure = error
    }
    try {
      if (fd !== undefined) closeSync(fd)
    } catch (error) {
      failure ??= error
    }
    try {
      unlinkSync(temporary)
    } catch (error) {
      if (error.code !== 'ENOENT') failure ??= error
    }
    if (failure) throw failure
  }
}

export function createPersistentOperatorSessions(token, options) {
  return new PersistentOperatorSessions(token, options)
}
