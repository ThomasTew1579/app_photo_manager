import type { AnalysisReport, DirectoryNode, MediaFile } from '../types/files'
import { extractExifCreatedAt } from './exif'
import {
  isAppMetaFile,
  oldestTimestamp,
  readMetaMap,
  type FileMetaEntry,
} from './datesStore'

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.heif', '.avif',
  '.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.rw2', '.orf', '.pef', '.srw',
])
const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv', '.mpeg', '.mpg', '.3gp',
])

function getExtension(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function classifyFile(name: string, mimeType: string): MediaFile['type'] {
  const ext = getExtension(name)
  if (IMAGE_EXT.has(ext) || mimeType.startsWith('image/')) return 'image'
  if (VIDEO_EXT.has(ext) || mimeType.startsWith('video/')) return 'video'
  return 'other'
}

function makeId(path: string): string {
  return path
}

/**
 * Priorité date :
 * 1) EXIF (si présent)
 * 2) createdAt du JSON app (date d’origine avant organisation)
 * 3) plus ancienne entre lastModified JSON d’origine et mtime FS
 */
async function resolveCreatedAt(
  file: File,
  type: MediaFile['type'],
  meta: FileMetaEntry | undefined,
): Promise<{ createdAt: number; originalLastModified?: number; aHash?: string }> {
  let exif: number | null = null
  if (type === 'image') {
    try {
      exif = await extractExifCreatedAt(file)
    } catch {
      /* ignore */
    }
  }

  const jsonCreated = meta?.createdAt
  const jsonMtime = meta?.lastModified
  const fsMtime = file.lastModified

  // EXIF et JSON createdAt priment sur le mtime FS (souvent = date d’organisation)
  const createdAt =
    exif != null
      ? oldestTimestamp(exif, jsonCreated)
      : jsonCreated != null
        ? oldestTimestamp(jsonCreated, jsonMtime, fsMtime)
        : oldestTimestamp(jsonMtime, fsMtime)

  const aHash =
    meta?.aHash && (meta.size == null || meta.size === file.size) ? meta.aHash : undefined

  return {
    createdAt,
    originalLastModified: jsonMtime,
    aHash,
  }
}

async function scanDirectory(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string,
  relativeBase: string,
  files: MediaFile[],
  onProgress?: (count: number) => void,
): Promise<DirectoryNode> {
  const node: DirectoryNode = {
    name: dirHandle.name,
    path: basePath,
    relativePath: relativeBase,
    fileCount: 0,
    imageCount: 0,
    videoCount: 0,
    totalSize: 0,
    children: [],
    files: [],
  }

  const entries: Array<[string, FileSystemHandle]> = []
  for await (const entry of dirHandle.entries()) {
    entries.push(entry)
  }
  entries.sort((a, b) => a[0].localeCompare(b[0], 'fr'))

  const metaMap = await readMetaMap(dirHandle)

  for (const [name, handle] of entries) {
    if (isAppMetaFile(name)) continue

    const path = `${basePath}/${name}`
    const relativePath = relativeBase ? `${relativeBase}/${name}` : name

    if (handle.kind === 'directory') {
      const child = await scanDirectory(
        handle as FileSystemDirectoryHandle,
        path,
        relativePath,
        files,
        onProgress,
      )
      node.children.push(child)
      node.fileCount += child.fileCount
      node.imageCount += child.imageCount
      node.videoCount += child.videoCount
      node.totalSize += child.totalSize
    } else if (handle.kind === 'file') {
      const fileHandle = handle as FileSystemFileHandle
      const file = await fileHandle.getFile()
      const type = classifyFile(name, file.type)
      const resolved = await resolveCreatedAt(file, type, metaMap[name])
      const media: MediaFile = {
        id: makeId(path),
        name,
        path,
        relativePath,
        size: file.size,
        type,
        mimeType: file.type || 'application/octet-stream',
        lastModified: file.lastModified,
        createdAt: resolved.createdAt,
        originalLastModified: resolved.originalLastModified,
        aHash: resolved.aHash,
        handle: fileHandle,
        parentPath: basePath,
      }
      node.files.push(media)
      files.push(media)
      node.fileCount += 1
      node.totalSize += file.size
      if (type === 'image') node.imageCount += 1
      if (type === 'video') node.videoCount += 1
      onProgress?.(files.length)
    }
  }

  return node
}

export async function analyzeDirectory(
  dirHandle: FileSystemDirectoryHandle,
  onProgress?: (count: number) => void,
): Promise<AnalysisReport> {
  const files: MediaFile[] = []
  const tree = await scanDirectory(dirHandle, dirHandle.name, '', files, onProgress)

  const countDirs = (node: DirectoryNode): number =>
    1 + node.children.reduce((sum, child) => sum + countDirs(child), 0)

  return {
    rootName: dirHandle.name,
    scannedAt: new Date(),
    totalFiles: files.length,
    totalImages: files.filter((f) => f.type === 'image').length,
    totalVideos: files.filter((f) => f.type === 'video').length,
    totalOthers: files.filter((f) => f.type === 'other').length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    directoryCount: countDirs(tree),
    tree,
    files,
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('fr-FR')
}

export function isDirectoryPickerSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/** Dossier sans aucun fichier dans toute la sous-arborescence. */
export function isEmptyDirectory(node: DirectoryNode): boolean {
  return node.fileCount === 0
}

function recountNode(node: DirectoryNode): DirectoryNode {
  const children = node.children
  const fileCount =
    node.files.length + children.reduce((sum, c) => sum + c.fileCount, 0)
  const imageCount =
    node.files.filter((f) => f.type === 'image').length +
    children.reduce((sum, c) => sum + c.imageCount, 0)
  const videoCount =
    node.files.filter((f) => f.type === 'video').length +
    children.reduce((sum, c) => sum + c.videoCount, 0)
  const totalSize =
    node.files.reduce((sum, f) => sum + f.size, 0) +
    children.reduce((sum, c) => sum + c.totalSize, 0)
  return { ...node, children, fileCount, imageCount, videoCount, totalSize }
}

/**
 * Retire un dossier (et sa sous-arborescence) de l’arbre en mémoire,
 * sans rescanner le disque.
 */
export function removeDirectoryByRelativePath(
  root: DirectoryNode,
  relativePath: string,
): DirectoryNode {
  if (!relativePath) return root

  function walk(node: DirectoryNode): DirectoryNode | null {
    if (node.relativePath === relativePath) return null
    let changed = false
    const children: DirectoryNode[] = []
    for (const child of node.children) {
      const next = walk(child)
      if (next === null) {
        changed = true
        continue
      }
      if (next !== child) changed = true
      children.push(next)
    }
    if (!changed) return node
    return recountNode({ ...node, children })
  }

  return walk(root) ?? root
}

export function countDirectories(node: DirectoryNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countDirectories(child), 0)
}
