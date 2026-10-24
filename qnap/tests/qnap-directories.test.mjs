import assert from 'node:assert/strict'
import test from 'node:test'
import {
  installShares,
  parseShares,
  wrapDirectoryService,
} from '../patches/qnap-directories.mjs'

const movie = {
  name: 'movie',
  path: '/share/CACHEDEV2_DATA/movie',
  canonical: '/share/CACHEDEV2_DATA/movie',
  alias: '/share/movie',
}
const game = {
  name: 'game',
  path: '/share/CACHEDEV2_DATA/game',
  canonical: '/share/CACHEDEV2_DATA/game',
  alias: '/share/game',
}
function serviceFixture() {
  return {
    async locations() {
      return {
        ok: true,
        value: {
          common: [
            { kind: 'default', path: movie.path + '/Motrix' },
            { kind: 'root', path: '/' },
          ],
          favorites: [],
          recent: [],
        },
      }
    },
    async list(request) {
      return {
        ok: true,
        value: {
          path: request.path,
          parentPath: request.path === movie.path ? null : movie.path,
          breadcrumbs: [
            { name: 'movie', path: movie.path },
            ...(request.path !== movie.path
              ? [{ name: 'existing', path: request.path }]
              : []),
          ],
          entries: [
            { name: 'existing', path: movie.path + '/existing' },
            { name: '@Recycle', path: movie.path + '/@Recycle' },
          ],
          truncated: false,
          canCreate: false,
        },
      }
    },
    async validate() {
      return { ok: false, error: { code: 'permissionDenied' } }
    },
    async create() {
      return { ok: false, error: { code: 'permissionDenied' } }
    },
  }
}
test('SMB catalog includes real volume shares, excluding app/system shares and unsafe paths', () => {
  const input =
    '[global]\npath=/share/CACHEDEV1_DATA/global\n[movie]\npath=/share/CACHEDEV2_DATA/movie\n[Container]\npath=/share/CACHEDEV1_DATA/Container\n[homes]\npath=/share/CACHEDEV1_DATA/homes\n[bad]\npath=/etc\n[bad2]\npath=/share/CACHEDEV2_DATA/..\n[bad3]\npath=/share/CACHEDEV2_DATA/movie/sub\n[Public]\npath=/share/CACHEDEV1_DATA/Public'
  assert.deepEqual(
    parseShares(input).map((s) => s.name),
    ['movie', 'Public']
  )
})
test('browse-only roots do not require startup writes and replace nested legacy download roots', () => {
  const policy = {
    allowedRoots: [
      { configured: movie.path + '/Motrix', canonical: movie.path + '/Motrix' },
    ],
    resolveCandidate: (value) => ({ candidate: value }),
  }
  installShares(policy, [movie, game])
  assert.deepEqual(policy.allowedSaveDirs, [movie.path, game.path])
  assert.equal(
    policy.resolveCandidate('/share/movie/existing').candidate,
    movie.path + '/existing'
  )
  assert.equal(
    policy.resolveCandidate('/share/movie/../game/existing').candidate,
    game.path + '/existing'
  )
  assert.equal(
    policy.resolveCandidate('/share/movie-other').candidate,
    '/share/movie-other'
  )
})
test('NAS root lists named shares, not the underlying /share filesystem', async () => {
  const service = wrapDirectoryService(serviceFixture(), [movie, game])
  const result = await service.list({ path: '/share' })
  assert.deepEqual(result.value.entries, [
    { name: 'movie', path: movie.path },
    { name: 'game', path: game.path },
  ])
  assert.equal(result.value.canCreate, false)
  assert.equal(result.value.parentPath, null)
  const locations = await service.locations({}, {})
  assert.deepEqual(
    locations.value.common.map((s) => s.path),
    ['/share', movie.path + '/Motrix']
  )
})
test('share root returns to NAS catalog; existing child navigation stays intact', async () => {
  const service = wrapDirectoryService(serviceFixture(), [movie])
  const root = await service.list({ path: movie.path })
  assert.equal(root.value.parentPath, '/share')
  assert.deepEqual(
    root.value.breadcrumbs.map((c) => c.name),
    ['NAS', 'movie']
  )
  assert.deepEqual(
    root.value.entries.map((c) => c.name),
    ['existing']
  )
  const child = await service.list({ path: movie.path + '/existing' })
  assert.equal(child.value.parentPath, movie.path)
  assert.deepEqual(
    child.value.breadcrumbs.map((c) => c.name),
    ['NAS', 'movie', 'existing']
  )
})
test('read-only browsing never turns permission denial into successful selection or creation', async () => {
  const service = wrapDirectoryService(serviceFixture(), [movie])
  assert.equal((await service.list({ path: movie.path })).ok, true)
  for (const target of ['/share', movie.path]) {
    assert.equal(
      (await service.validate({ path: target })).error.code,
      'permissionDenied'
    )
    assert.equal(
      (await service.create({ parentPath: target, name: 'test' })).error.code,
      'permissionDenied'
    )
  }
})
test('virtual root keeps directory request validation and file picker metadata', async () => {
  const service = wrapDirectoryService(serviceFixture(), [movie])
  assert.equal(
    (await service.list({ path: '/share', showHidden: 'yes' })).error.code,
    'invalidPath'
  )
  assert.equal(
    (await service.list({ path: '/share', unexpected: true })).error.code,
    'invalidPath'
  )
  const files = await service.list({ path: '/share', includeFiles: true })
  assert.equal(files.value.entries[0].kind, 'directory')
  assert.equal(files.value.separator, '/')
})
