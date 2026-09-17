import type { AnalysisReport, DirectoryNode, MediaFile } from '../types/files'

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

  for (const [name, handle] of entries) {
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
      const media: MediaFile = {
        id: makeId(path),
        name,
        path,
        relativePath,
        size: file.size,
        type,
        mimeType: file.type || 'application/octet-stream',
        lastModified: file.lastModified,
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
