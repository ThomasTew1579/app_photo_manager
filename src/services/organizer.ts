import type { MediaFile } from '../types/files'

export type DateHierarchyLevel = 'year' | 'month' | 'day'

export interface OrganizeResult {
  moved: number
  skipped: number
  createdFolders: string[]
  errors: string[]
}

export interface OrganizePlanItem {
  file: MediaFile
  year: string
  month: string
  day: string
  folderSegments: string[]
  folderKey: string
  targetRelative: string
}

export const HIERARCHY_OPTIONS: Array<{
  value: DateHierarchyLevel
  label: string
  example: string
}> = [
  { value: 'year', label: 'Année seulement (YYYY)', example: '2024/' },
  { value: 'month', label: 'Année → mois (MM-YYYY)', example: '2024/03-2024/' },
  { value: 'day', label: 'Année → mois → jour (DD-MM-YYYY)', example: '2024/03-2024/15-03-2024/' },
]

export interface HierarchyPreviewNode {
  name: string
  key: string
  fileCount: number
  children: HierarchyPreviewNode[]
}

/** Aperçu arborescent année → mois → jour à partir du plan. */
export function buildHierarchyPreview(plan: OrganizePlanItem[]): HierarchyPreviewNode[] {
  type Mutable = { name: string; key: string; fileCount: number; children: Map<string, Mutable> }
  const roots = new Map<string, Mutable>()

  for (const item of plan) {
    let currentMap = roots
    let parentKey = ''
    let node: Mutable | undefined

    for (const segment of item.folderSegments) {
      const key = parentKey ? `${parentKey}/${segment}` : segment
      let child = currentMap.get(segment)
      if (!child) {
        child = { name: segment, key, fileCount: 0, children: new Map() }
        currentMap.set(segment, child)
      }
      node = child
      currentMap = child.children
      parentKey = key
    }
    if (node) node.fileCount += 1
  }

  const toArray = (map: Map<string, Mutable>): HierarchyPreviewNode[] =>
    [...map.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => ({
        name: n.name,
        key: n.key,
        fileCount: n.fileCount + sumChildFiles(n),
        children: toArray(n.children),
      }))

  function sumChildFiles(n: Mutable): number {
    let sum = 0
    for (const child of n.children.values()) {
      sum += child.fileCount + sumChildFiles(child)
    }
    return sum
  }

  return toArray(roots)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Année : YYYY */
export function formatYearFolder(d: Date): string {
  return String(d.getFullYear())
}

/** Mois : MM-YYYY (équivalent MM/YYYY, tiret car « / » interdit dans un nom de dossier) */
export function formatMonthFolder(d: Date): string {
  return `${pad2(d.getMonth() + 1)}-${d.getFullYear()}`
}

/** Jour : DD-MM-YYYY (équivalent DD/MM/YYYY) */
export function formatDayFolder(d: Date): string {
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`
}

export function buildFolderSegments(
  year: string,
  month: string,
  day: string,
  level: DateHierarchyLevel,
): string[] {
  if (level === 'year') return [year]
  if (level === 'month') return [year, month]
  return [year, month, day]
}

export function buildOrganizePlan(
  files: MediaFile[],
  level: DateHierarchyLevel = 'day',
): OrganizePlanItem[] {
  return files
    .filter((f) => f.type === 'image' || f.type === 'video')
    .map((file) => {
      const d = new Date(file.lastModified)
      const year = formatYearFolder(d)
      const month = formatMonthFolder(d)
      const day = formatDayFolder(d)
      const folderSegments = buildFolderSegments(year, month, day, level)
      const folderKey = folderSegments.join('/')
      return {
        file,
        year,
        month,
        day,
        folderSegments,
        folderKey,
        targetRelative: `${folderKey}/${file.name}`,
      }
    })
}

async function ensureDir(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle> {
  let current = root
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true })
  }
  return current
}

async function getParentHandle(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<{ parent: FileSystemDirectoryHandle; name: string } | null> {
  const parts = relativePath.split('/').filter(Boolean)
  if (parts.length === 0) return null
  const name = parts[parts.length - 1]
  let parent = root
  for (let i = 0; i < parts.length - 1; i++) {
    parent = await parent.getDirectoryHandle(parts[i])
  }
  return { parent, name }
}

function isAlreadyOrganized(relativePath: string, targetRelative: string): boolean {
  return relativePath === targetRelative || relativePath.endsWith(`/${targetRelative}`)
}

/**
 * Crée les dossiers selon le niveau choisi (année / mois / jour)
 * et y copie ou déplace les médias.
 */
export async function organizeByDate(
  rootHandle: FileSystemDirectoryHandle,
  files: MediaFile[],
  options: {
    move?: boolean
    level?: DateHierarchyLevel
    onProgress?: (done: number, total: number) => void
  } = {},
): Promise<OrganizeResult> {
  const move = options.move ?? true
  const level = options.level ?? 'day'
  const plan = buildOrganizePlan(files, level)
  const created = new Set<string>()
  const result: OrganizeResult = {
    moved: 0,
    skipped: 0,
    createdFolders: [],
    errors: [],
  }

  for (let i = 0; i < plan.length; i++) {
    const item = plan[i]
    options.onProgress?.(i + 1, plan.length)

    if (isAlreadyOrganized(item.file.relativePath, item.targetRelative)) {
      result.skipped++
      continue
    }

    try {
      const destDir = await ensureDir(rootHandle, item.folderSegments)
      if (!created.has(item.folderKey)) {
        created.add(item.folderKey)
        result.createdFolders.push(item.folderKey)
      }

      const sourceFile = await item.file.handle.getFile()
      const destHandle = await destDir.getFileHandle(item.file.name, { create: true })
      const writable = await destHandle.createWritable()
      await writable.write(sourceFile)
      await writable.close()

      if (move) {
        const parentInfo = await getParentHandle(rootHandle, item.file.relativePath)
        if (parentInfo) {
          await parentInfo.parent.removeEntry(parentInfo.name)
        }
      }

      result.moved++
    } catch (err) {
      result.errors.push(
        `${item.file.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return result
}

/**
 * Liste les répertoires vides (feuilles puis parents), hors racine.
 * Chemins relatifs à la racine analysée.
 */
export async function findEmptyDirectories(
  root: FileSystemDirectoryHandle,
): Promise<string[]> {
  const empty: string[] = []

  async function walk(dir: FileSystemDirectoryHandle, relativePath: string): Promise<boolean> {
    const subdirs: Array<{ name: string; handle: FileSystemDirectoryHandle }> = []
    let hasFiles = false

    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') hasFiles = true
      else subdirs.push({ name, handle: handle as FileSystemDirectoryHandle })
    }

    let allChildrenEmpty = true
    for (const sub of subdirs) {
      const childPath = relativePath ? `${relativePath}/${sub.name}` : sub.name
      const childEmpty = await walk(sub.handle, childPath)
      if (!childEmpty) allChildrenEmpty = false
    }

    const isEmpty = !hasFiles && allChildrenEmpty
    if (isEmpty && relativePath) {
      empty.push(relativePath)
    }
    return isEmpty
  }

  await walk(root, '')
  return empty
}

export async function removeEmptyDirectories(
  root: FileSystemDirectoryHandle,
  relativePaths: string[],
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = []
  const errors: string[] = []

  const sorted = [...relativePaths].sort(
    (a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a),
  )

  for (const path of sorted) {
    try {
      const parts = path.split('/').filter(Boolean)
      const name = parts[parts.length - 1]
      let parent = root
      for (let i = 0; i < parts.length - 1; i++) {
        parent = await parent.getDirectoryHandle(parts[i])
      }
      await parent.removeEntry(name, { recursive: true })
      removed.push(path)
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { removed, errors }
}
