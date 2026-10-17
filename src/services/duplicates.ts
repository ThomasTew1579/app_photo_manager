import type {
  DuplicateGroup,
  DuplicateSortMode,
  DuplicateTag,
  DuplicateTagKind,
  MediaFile,
} from '../types/files'
import {
  persistMetasUnderRoot,
  removeMetaEntry,
  type FileMetaEntry,
  type SimilarRef,
} from './datesStore'
import { toDecodableImageBlob } from './heic'

const HASH_SIZE = 8

const TAG_PRIORITY: Record<DuplicateTagKind, number> = {
  rafale: 0,
  taille: 1,
  exact: 2,
  fiable: 3,
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Impossible de charger l’image'))
    }
    img.src = url
  })
}

/** Average hash (aHash) — robuste pour détecter les doublons visuels proches. */
export async function computeAverageHash(file: Blob): Promise<string> {
  const img = await loadImageFromBlob(file)
  const canvas = document.createElement('canvas')
  canvas.width = HASH_SIZE
  canvas.height = HASH_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas indisponible')

  ctx.drawImage(img, 0, 0, HASH_SIZE, HASH_SIZE)
  const { data } = ctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE)

  const grays: number[] = []
  for (let i = 0; i < data.length; i += 4) {
    grays.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
  }
  const avg = grays.reduce((a, b) => a + b, 0) / grays.length
  return grays.map((g) => (g >= avg ? '1' : '0')).join('')
}

function hammingDistance(a: string, b: string): number {
  let dist = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) dist++
  }
  return dist + Math.abs(a.length - b.length)
}

/** Distance de Levenshtein entre deux chaînes. */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function basenameWithoutExt(name: string): string {
  const i = name.lastIndexOf('.')
  return (i >= 0 ? name.slice(0, i) : name).toLowerCase()
}

/** Motif de nom : chiffres remplacés par # + liste des numéros (IMG_0042 → stem IMG_#). */
export function extractNamePattern(name: string): { stem: string; numbers: number[] } | null {
  const base = basenameWithoutExt(name)
  const matches = [...base.matchAll(/\d+/g)]
  if (matches.length === 0) return null
  return {
    stem: base.replace(/\d+/g, '#'),
    numbers: matches.map((m) => Number.parseInt(m[0], 10)),
  }
}

/**
 * Numéros qui se suivent dans le nom (ex. IMG_0042 / IMG_0043) → forte chance de rafale.
 * Même dossier, même motif textuel, un seul compteur qui diffère de 1 à 3.
 */
export function hasSequentialNumbers(a: MediaFile, b: MediaFile): boolean {
  if (a.parentPath !== b.parentPath) return false
  const pa = extractNamePattern(a.name)
  const pb = extractNamePattern(b.name)
  if (!pa || !pb || pa.stem !== pb.stem || pa.numbers.length !== pb.numbers.length) {
    return false
  }

  let diffCount = 0
  let absDiff = 0
  for (let i = 0; i < pa.numbers.length; i++) {
    if (pa.numbers[i] !== pb.numbers[i]) {
      diffCount++
      absDiff = Math.abs(pa.numbers[i] - pb.numbers[i])
    }
  }
  return diffCount === 1 && absDiff >= 1 && absDiff <= 3
}

/**
 * Rafale : même dossier + (noms très proches OU numéros séquentiels dans le nom).
 */
export function isBurstPair(a: MediaFile, b: MediaFile): boolean {
  if (a.parentPath !== b.parentPath) return false
  if (hasSequentialNumbers(a, b)) return true
  const dist = levenshtein(basenameWithoutExt(a.name), basenameWithoutExt(b.name))
  return dist >= 2 && dist <= 3
}

function hasBurstInGroup(files: MediaFile[]): boolean {
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      if (isBurstPair(files[i], files[j])) return true
    }
  }
  return false
}

function sizeSpreadRatio(files: MediaFile[]): number {
  const sizes = files.map((f) => f.size)
  const min = Math.min(...sizes)
  const max = Math.max(...sizes)
  if (min === 0) return max === 0 ? 0 : 1
  return (max - min) / min
}

function buildTags(files: MediaFile[], hashes: string[]): DuplicateTag[] {
  const tags: DuplicateTag[] = []
  const allExact = hashes.every((h) => h === hashes[0])

  if (hasBurstInGroup(files)) {
    tags.push({
      kind: 'rafale',
      label: 'Rafale (noms proches / n° qui se suivent)',
    })
  }

  if (allExact) {
    tags.push({ kind: 'exact', label: 'Hash identique' })
  }

  if (sizeSpreadRatio(files) > 0.15) {
    tags.push({ kind: 'taille', label: 'Tailles différentes' })
  }

  const sameFolder = files.every((f) => f.parentPath === files[0].parentPath)
  if (!tags.some((t) => t.kind === 'rafale') && (!sameFolder || allExact)) {
    tags.push({ kind: 'fiable', label: 'Doublon probable' })
  }

  if (tags.length === 0) {
    tags.push({ kind: 'fiable', label: 'Doublon probable' })
  }

  return tags
}

function computeRelevance(files: MediaFile[], hashes: string[], tags: DuplicateTag[]): number {
  let score = 55
  const allExact = hashes.every((h) => h === hashes[0])
  if (allExact) score += 30

  const sameFolder = files.every((f) => f.parentPath === files[0].parentPath)
  if (!sameFolder) score += 15
  else score -= 5

  if (sizeSpreadRatio(files) < 0.05) score += 10
  else if (sizeSpreadRatio(files) > 0.25) score -= 15

  if (tags.some((t) => t.kind === 'rafale')) score -= 35
  if (tags.some((t) => t.kind === 'taille')) score -= 10

  score += Math.min(files.length - 2, 3) * 3

  return Math.max(0, Math.min(100, score))
}

export interface DuplicateScanOptions {
  /** Distance de Hamming max pour considérer deux images comme similaires (0 = identiques). */
  threshold?: number
  onProgress?: (done: number, total: number) => void
  /** Résultats partiels pendant le scan (tous les `partialEvery` fichiers). */
  onPartial?: (groups: DuplicateGroup[], done: number, total: number) => void
  /** Fréquence d’émission des résultats partiels (défaut 40). */
  partialEvery?: number
  /** Nombre de hashs calculés en parallèle (défaut 4). */
  concurrency?: number
  /** Permet d’interrompre l’analyse (résultats partiels conservés). */
  signal?: AbortSignal
  /**
   * Racine FS : si fournie, écrit aHash + similarités dans `_photo_meta.json`
   * pour accélérer les analyses suivantes.
   */
  persistRoot?: FileSystemDirectoryHandle
}

export class DuplicateScanAbortedError extends Error {
  readonly groups: DuplicateGroup[]
  constructor(groups: DuplicateGroup[]) {
    super('Analyse des doublons interrompue')
    this.name = 'DuplicateScanAbortedError'
    this.groups = groups
  }
}

function buildGroupsFromHashed(
  hashed: Array<{ file: MediaFile; hash: string }>,
  threshold: number,
): DuplicateGroup[] {
  const used = new Set<number>()
  const groups: DuplicateGroup[] = []

  for (let i = 0; i < hashed.length; i++) {
    if (used.has(i)) continue
    const members = [hashed[i]]
    used.add(i)

    for (let j = i + 1; j < hashed.length; j++) {
      if (used.has(j)) continue
      if (hammingDistance(hashed[i].hash, hashed[j].hash) <= threshold) {
        members.push(hashed[j])
        used.add(j)
      }
    }

    if (members.length > 1) {
      const groupFiles = members.map((m) => m.file)
      const hashes = members.map((m) => m.hash)
      const tags = buildTags(groupFiles, hashes)
      groups.push({
        id: `dup-${hashed[i].hash}-${groupFiles[0].id}`,
        hash: hashed[i].hash,
        files: groupFiles,
        tags,
        relevance: computeRelevance(groupFiles, hashes, tags),
      })
    }
  }

  return sortDuplicateGroups(groups, 'pertinence')
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 32 })
    } else {
      setTimeout(resolve, 0)
    }
  })
}

function buildSimilarUpdates(
  hashed: Array<{ file: MediaFile; hash: string }>,
  threshold: number,
): Array<{ relativePath: string; entry: FileMetaEntry }> {
  const updates: Array<{ relativePath: string; entry: FileMetaEntry }> = []

  for (let i = 0; i < hashed.length; i++) {
    const similar: SimilarRef[] = []
    for (let j = 0; j < hashed.length; j++) {
      if (i === j) continue
      const distance = hammingDistance(hashed[i].hash, hashed[j].hash)
      if (distance <= threshold) {
        similar.push({
          name: hashed[j].file.name,
          relativePath: hashed[j].file.relativePath,
          distance,
        })
      }
    }
    similar.sort((a, b) => a.distance - b.distance)
    // Garde les voisins les plus proches (évite des JSON énormes)
    const topSimilar = similar.slice(0, 12)
    const f = hashed[i].file
    updates.push({
      relativePath: f.relativePath,
      entry: {
        createdAt: f.createdAt,
        lastModified: f.originalLastModified ?? f.lastModified,
        size: f.size,
        aHash: hashed[i].hash,
        similar: topSimilar.length ? topSimilar : undefined,
      },
    })
    f.aHash = hashed[i].hash
  }

  return updates
}

export async function findDuplicateImages(
  files: MediaFile[],
  options: DuplicateScanOptions = {},
): Promise<DuplicateGroup[]> {
  const threshold = options.threshold ?? 2
  const partialEvery = options.partialEvery ?? 40
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const signal = options.signal
  const images = files.filter((f) => f.type === 'image')
  const hashed: Array<{ file: MediaFile; hash: string }> = []
  let done = 0
  const total = images.length

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new DuplicateScanAbortedError(buildGroupsFromHashed(hashed, threshold))
    }
  }

  async function hashOne(media: MediaFile) {
    throwIfAborted()
    try {
      // Réutilise le aHash du JSON / scan précédent si taille cohérente
      if (media.aHash && media.aHash.length >= HASH_SIZE * HASH_SIZE) {
        hashed.push({ file: media, hash: media.aHash })
        return
      }
      const raw = await media.handle.getFile()
      throwIfAborted()
      const blob = await toDecodableImageBlob(raw, media.name)
      throwIfAborted()
      const hash = await computeAverageHash(blob)
      media.aHash = hash
      hashed.push({ file: media, hash })
    } catch (e) {
      if (e instanceof DuplicateScanAbortedError) throw e
      /* ignore decode errors */
    } finally {
      done += 1
      options.onProgress?.(done, total)
      if (done % partialEvery === 0 || done === total) {
        options.onPartial?.(buildGroupsFromHashed(hashed, threshold), done, total)
        await yieldToMain()
      }
    }
  }

  for (let i = 0; i < images.length; i += concurrency) {
    throwIfAborted()
    const batch = images.slice(i, i + concurrency)
    await Promise.all(batch.map((m) => hashOne(m)))
  }

  throwIfAborted()
  const groups = buildGroupsFromHashed(hashed, threshold)

  if (options.persistRoot && hashed.length > 0) {
    try {
      await persistMetasUnderRoot(options.persistRoot, buildSimilarUpdates(hashed, threshold))
    } catch {
      /* persistance best-effort */
    }
  }

  return groups
}

export function sortDuplicateGroups(
  groups: DuplicateGroup[],
  mode: DuplicateSortMode,
): DuplicateGroup[] {
  const copy = [...groups]
  if (mode === 'pertinence') {
    copy.sort((a, b) => b.relevance - a.relevance)
  } else if (mode === 'tag') {
    copy.sort((a, b) => {
      const pa = Math.min(...a.tags.map((t) => TAG_PRIORITY[t.kind]))
      const pb = Math.min(...b.tags.map((t) => TAG_PRIORITY[t.kind]))
      if (pa !== pb) return pa - pb
      return b.relevance - a.relevance
    })
  } else {
    copy.sort((a, b) => b.files.length - a.files.length || b.relevance - a.relevance)
  }
  return copy
}

export async function createPreviewUrl(file: MediaFile): Promise<string> {
  const raw = await file.handle.getFile()
  const blob = await toDecodableImageBlob(raw, file.name)
  return URL.createObjectURL(blob)
}

/** Supprime un fichier média relatif à la racine analysée. */
export async function deleteMediaFile(
  root: FileSystemDirectoryHandle,
  file: MediaFile,
): Promise<void> {
  const parts = file.relativePath.split('/').filter(Boolean)
  if (parts.length === 0) throw new Error('Chemin invalide')
  const name = parts[parts.length - 1]
  let dir = root
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i])
  }
  try {
    await removeMetaEntry(dir, name)
  } catch {
    /* ignore */
  }
  await dir.removeEntry(name)
}

export async function deleteMediaFiles(
  root: FileSystemDirectoryHandle,
  files: MediaFile[],
): Promise<{ deleted: string[]; errors: string[] }> {
  const deleted: string[] = []
  const errors: string[] = []
  for (const file of files) {
    try {
      await deleteMediaFile(root, file)
      deleted.push(file.relativePath)
    } catch (e) {
      errors.push(`${file.relativePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { deleted, errors }
}
