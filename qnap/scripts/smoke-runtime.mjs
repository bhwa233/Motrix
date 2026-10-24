import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

const root = fs.realpathSync(process.argv[2])
const temporaryRoot = process.argv[3] ?? os.tmpdir()
assert.equal(process.arch, 'x64')
assert.equal(process.platform, 'linux')
assert.equal(process.execPath, path.join(root, 'runtime/bin/node'))
const expectedUid = process.env.MOTRIX_SMOKE_EXPECT_UID
if (expectedUid !== undefined)
  assert.equal(process.getuid(), Number(expectedUid))
else
  assert.notEqual(
    process.getuid(),
    0,
    'Set MOTRIX_SMOKE_EXPECT_UID=0 to test administrator mode'
  )
assert.equal(
  Number(
    execFileSync(process.execPath, ['-p', 'process.getuid()'], {
      encoding: 'utf8',
    }).trim()
  ),
  process.getuid()
)
const childVersion = execFileSync(process.execPath, ['--version'], {
  encoding: 'utf8',
}).trim()
assert.equal(childVersion, process.version)
const workerValue = await new Promise((resolve, reject) => {
  const worker = new Worker(
    "require('node:worker_threads').parentPort.postMessage(42)",
    { eval: true }
  )
  worker.once('message', resolve)
  worker.once('error', reject)
})
assert.equal(workerValue, 42)
const directory = fs.mkdtempSync(
  path.join(temporaryRoot, 'motrix native smoke ')
)
const require = createRequire(path.join(root, 'server/package.json'))
const Database = require('better-sqlite3')
let sqlite
try {
  const database = new Database(path.join(directory, 'smoke.sqlite'))
  database.pragma('journal_mode = WAL')
  database.exec('CREATE TABLE checks (value TEXT NOT NULL)')
  database.prepare('INSERT INTO checks VALUES (?)').run('持久化验证')
  sqlite = database.prepare('SELECT sqlite_version() AS version').get().version
  database.close()
  const reopened = new Database(path.join(directory, 'smoke.sqlite'))
  assert.equal(
    reopened.prepare('SELECT value FROM checks').get().value,
    '持久化验证'
  )
  reopened.close()
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
console.log(
  JSON.stringify({
    ok: true,
    node: process.version,
    sqlite,
    uid: process.getuid(),
    execPath: process.execPath,
    childProcess: true,
    workerThreads: true,
    sqliteWalPersistence: true,
  })
)
