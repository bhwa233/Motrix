import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export const NAS_ROOT = '/share'
const excluded = new Set([
  'global',
  'home',
  'homes',
  'Container',
  'Browser Station',
])
const systemNames = new Set([
  '@Recycle',
  '@Recently-Snapshot',
  '@Snapshot',
  '@eaDir',
  '.qpkg',
  '.snapshot',
])
const volumeShare =
  /^\/share\/(?:CACHEDEV\d+_DATA|MD\d+_DATA|HD[A-Z]_DATA)\/[^/]+$/
const inside = (root, value) => value === root || value.startsWith(root + '/')

// Parse only the share name and path; do not copy SMB credentials into state or logs.
export function parseShares(text) {
  const shares = []
  let section
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) {
      section = header[1]
      continue
    }
    const value = line.match(/^\s*path\s*=\s*(.*?)\s*$/i)
    if (
      !value ||
      !section ||
      excluded.has(section) ||
      section.startsWith('.') ||
      section.includes('/') ||
      section.includes('\\')
    )
      continue
    const target = value[1]
    if (
      !volumeShare.test(target) ||
      target.includes('\0') ||
      target.includes(':') ||
      target.split('/').some((x) => x === '.' || x === '..')
    )
      continue
    shares.push({ name: section, path: target, alias: '/share/' + section })
  }
  return shares.filter(
    (entry, index) =>
      shares.findIndex((other) => other.path === entry.path) === index
  )
}

export async function loadShares(config = '/etc/config/smb.conf') {
  const result = []
  for (const share of parseShares(await readFile(config, 'utf8'))) {
    try {
      const canonical = await realpath(share.path)
      // Never follow a registered root into system directories or another nested path.
      if (
        !volumeShare.test(canonical) ||
        !(await stat(canonical)).isDirectory()
      )
        continue
      await access(canonical, constants.R_OK | constants.X_OK)
      result.push({ ...share, canonical })
    } catch {
      /* Unmounted and unreadable shares are unavailable to this service. */
    }
  }
  return result
}

export function installShares(policy, shares) {
  const roots = shares.map((share) => ({
    configured: share.path,
    canonical: share.canonical,
  }))
  policy.allowedRoots = [
    ...policy.allowedRoots.filter(
      (old) => !roots.some((root) => inside(root.canonical, old.canonical))
    ),
    ...roots,
  ]
  policy.allowedSaveDirs = policy.allowedRoots.map((root) => root.configured)
  const resolve = policy.resolveCandidate.bind(policy)
  policy.resolveCandidate = (value) => {
    // Support QNAP's familiar /share/<name> aliases without weakening realpath checks.
    if (typeof value === 'string' && path.isAbsolute(value)) {
      const normalized = path.resolve(value)
      const share = shares.find((share) => inside(share.alias, normalized))
      if (share) value = share.path + normalized.slice(share.alias.length)
    }
    return resolve(value)
  }
}

export function wrapDirectoryService(service, shares) {
  const list = service.list.bind(service)
  const locations = service.locations.bind(service)
  const validate = service.validate.bind(service)
  const create = service.create.bind(service)
  service.locations = async (request, settings) => {
    const result = await locations(request, settings)
    if (result.ok)
      result.value.common = [
        { kind: 'root', path: NAS_ROOT },
        ...result.value.common.filter((entry) => entry.kind === 'default'),
      ]
    return result
  }
  service.list = async (request) => {
    if (request?.path === NAS_ROOT) {
      // Keep the upstream request validation for invalid keys and value types.
      const keys = ['path', 'showHidden', 'includeFiles', 'initialFile']
      if (
        Object.keys(request).some((key) => !keys.includes(key)) ||
        keys
          .slice(1)
          .some(
            (key) =>
              request[key] !== undefined && typeof request[key] !== 'boolean'
          )
      )
        return { ok: false, error: { code: 'invalidPath' } }
      return {
        ok: true,
        value: {
          path: NAS_ROOT,
          parentPath: null,
          breadcrumbs: [{ name: 'NAS', path: NAS_ROOT }],
          entries: shares.map((share) => ({
            name: share.name,
            path: share.path,
            ...(request.includeFiles ? { kind: 'directory' } : {}),
          })),
          truncated: false,
          canCreate: false,
          ...(request.includeFiles ? { separator: '/' } : {}),
        },
      }
    }
    const result = await list(request)
    if (result.ok) {
      const share = shares.find((share) =>
        inside(share.path, result.value.path)
      )
      if (share) {
        result.value.breadcrumbs = [
          { name: 'NAS', path: NAS_ROOT },
          ...result.value.breadcrumbs.map((crumb) =>
            crumb.path === share.path ? { ...crumb, name: share.name } : crumb
          ),
        ]
        if (result.value.path === share.path) result.value.parentPath = NAS_ROOT
      }
      result.value.entries = result.value.entries.filter(
        (entry) => !systemNames.has(entry.name)
      )
    }
    return result
  }
  service.validate = async (request) =>
    request?.path === NAS_ROOT
      ? { ok: false, error: { code: 'permissionDenied' } }
      : validate(request)
  service.create = async (request) =>
    request?.parentPath === NAS_ROOT
      ? { ok: false, error: { code: 'permissionDenied' } }
      : create(request)
  return service
}

export async function configureQnapPolicy(policy) {
  const shares = await loadShares()
  installShares(policy, shares)
  return shares
}
