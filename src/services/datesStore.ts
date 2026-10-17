/**
 * Métadonnées persistées par dossier pour survivre aux write FS
 * (mtime réécrit) et accélérer un second scan / doublons.
 *
 * Fichier : `_photo_meta.json`
 * Ancien format `_dates.json` ({ "a.jpg": 123 }) encore lu en secours.
 */
export const META_FILENAME = '_photo_meta.json'
/** @deprecated Ancien nom — encore supporté en lecture. */
export const DATES_FILENAME = '_dates.json'

export interface SimilarRef {
  /** Nom du fichier dans le même dossier, ou chemin relatif. */
  name: string
  relativePath?: string
  /** Distance de Hamming entre aHash (0 = identique). */
  distance: number
}

export interface FileMetaEntry {
  /** Date de création logique d’origine (prioritaire après EXIF). */
  createdAt: number
  /** lastModified d’origine, avant organisation. */
  lastModified: number
  size?: number
  /** Average hash pour accélérer la détection de doublons. */
  aHash?: string
  /** Voisins similaires connus (distance). */
  similar?: SimilarRef[]
}

export type MetaMap = Record<string, FileMetaEntry>

/** @deprecated Compat lecture ancienne. */
export type DatesMap = Record<string, number>

export interface PhotoMetaFile {
  version: 2
  generatedBy: 'photo-manager'
  updatedAt: string
  files: MetaMap
}

/** Retourne la date la plus ancienne parmi les candidats valides. */
export function oldestTimestamp(...candidates: Array<number | null | undefined>): number {
  const valid = candidates.filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
  )
  if (valid.length === 0) return Date.now()
  return Math.min(...valid)
}

function isMetaEntry(v: unknown): v is FileMetaEntry {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.createdAt === 'number' && Number.isFinite(o.createdAt)
}

function parseMetaPayload(parsed: unknown): MetaMap {
  if (!parsed || typeof parsed !== 'object') return {}
  const root = parsed as Record<string, unknown>

  // Nouveau format v2
  if (root.files && typeof root.files === 'object') {
    const out: MetaMap = {}
    for (const [name, entry] of Object.entries(root.files as Record<string, unknown>)) {
      if (!isMetaEntry(entry)) continue
      const e = entry as FileMetaEntry
      out[name] = {
        createdAt: e.createdAt,
        lastModified:
          typeof e.lastModified === 'number' && Number.isFinite(e.lastModified)
            ? e.lastModified
            : e.createdAt,
        size: typeof e.size === 'number' ? e.size : undefined,
        aHash: typeof e.aHash === 'string' ? e.aHash : undefined,
        similar: Array.isArray(e.similar) ? e.similar : undefined,
      }
    }
    return out
  }

  // Ancien format { "photo.jpg": 1690000000000 }
  const out: MetaMap = {}
  for (const [k, v] of Object.entries(root)) {
    if (k === 'version' || k === 'generatedBy' || k === 'updatedAt' || k === 'files') continue
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = { createdAt: v, lastModified: v }
    }
  }
  return out
}

async function readJsonFromDir(
  dir: FileSystemDirectoryHandle,
  fileName: string,
): Promise<unknown | null> {
  try {
    const handle = await dir.getFileHandle(fileName)
    const file = await handle.getFile()
    return JSON.parse(await file.text()) as unknown
  } catch {
    return null
  }
}

export async function readMetaMap(dir: FileSystemDirectoryHandle): Promise<MetaMap> {
  const modern = await readJsonFromDir(dir, META_FILENAME)
  if (modern) return parseMetaPayload(modern)
  const legacy = await readJsonFromDir(dir, DATES_FILENAME)
  if (legacy) return parseMetaPayload(legacy)
  return {}
}

/** Compat : map name → createdAt uniquement. */
export async function readDatesMap(dir: FileSystemDirectoryHandle): Promise<DatesMap> {
  const meta = await readMetaMap(dir)
  const out: DatesMap = {}
  for (const [name, entry] of Object.entries(meta)) {
    out[name] = entry.createdAt
  }
  return out
}

export async function writeMetaMap(
  dir: FileSystemDirectoryHandle,
  map: MetaMap,
): Promise<void> {
  const payload: PhotoMetaFile = {
    version: 2,
    generatedBy: 'photo-manager',
    updatedAt: new Date().toISOString(),
    files: map,
  }
  const handle = await dir.getFileHandle(META_FILENAME, { create: true })
  const writable = await handle.createWritable()
  await writable.write(`${JSON.stringify(payload, null, 2)}\n`)
  await writable.close()
}

/** @deprecated Utiliser writeMetaMap. */
export async function writeDatesMap(
  dir: FileSystemDirectoryHandle,
  map: DatesMap,
): Promise<void> {
  const existing = await readMetaMap(dir)
  for (const [name, createdAt] of Object.entries(map)) {
    const prev = existing[name]
    existing[name] = {
      createdAt,
      lastModified: prev?.lastModified ?? createdAt,
      size: prev?.size,
      aHash: prev?.aHash,
      similar: prev?.similar,
    }
  }
  await writeMetaMap(dir, existing)
}

export async function removeMetaEntry(
  dir: FileSystemDirectoryHandle,
  fileName: string,
): Promise<void> {
  const map = await readMetaMap(dir)
  if (!(fileName in map)) return
  delete map[fileName]
  if (Object.keys(map).length === 0) {
    try {
      await dir.removeEntry(META_FILENAME)
    } catch {
      /* ignore */
    }
    try {
      await dir.removeEntry(DATES_FILENAME)
    } catch {
      /* ignore */
    }
    return
  }
  await writeMetaMap(dir, map)
}

/** @deprecated */
export async function removeDateEntry(
  dir: FileSystemDirectoryHandle,
  fileName: string,
): Promise<void> {
  return removeMetaEntry(dir, fileName)
}

export function isAppMetaFile(name: string): boolean {
  return name === META_FILENAME || name === DATES_FILENAME
}

/**
 * Fusionne des mises à jour de meta dans les dossiers parents
 * (chemins relatifs à la racine analysée).
 */
export async function persistMetasUnderRoot(
  root: FileSystemDirectoryHandle,
  updates: Array<{ relativePath: string; entry: FileMetaEntry }>,
): Promise<void> {
  const byDir = new Map<string, Array<{ name: string; entry: FileMetaEntry }>>()

  for (const u of updates) {
    const parts = u.relativePath.split('/').filter(Boolean)
    if (parts.length === 0) continue
    const name = parts[parts.length - 1]
    const dirKey = parts.slice(0, -1).join('/')
    let list = byDir.get(dirKey)
    if (!list) {
      list = []
      byDir.set(dirKey, list)
    }
    list.push({ name, entry: u.entry })
  }

  for (const [dirKey, list] of byDir) {
    let dir = root
    if (dirKey) {
      for (const seg of dirKey.split('/')) {
        dir = await dir.getDirectoryHandle(seg)
      }
    }
    const map = await readMetaMap(dir)
    for (const { name, entry } of list) {
      const prev = map[name]
      map[name] = {
        createdAt: entry.createdAt,
        lastModified: entry.lastModified,
        size: entry.size ?? prev?.size,
        aHash: entry.aHash ?? prev?.aHash,
        similar: entry.similar ?? prev?.similar,
      }
    }
    await writeMetaMap(dir, map)
  }
}
