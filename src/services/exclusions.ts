import type { MediaFile } from '../types/files'

/** Un fichier est exclu s’il se trouve dans un dossier exclu ou un de ses sous-dossiers. */
export function isFileExcluded(file: MediaFile, excludedPaths: string[]): boolean {
  if (excludedPaths.length === 0) return false
  return excludedPaths.some(
    (ex) =>
      file.parentPath === ex ||
      file.parentPath.startsWith(`${ex}/`) ||
      file.path === ex ||
      file.path.startsWith(`${ex}/`),
  )
}

export function filterActiveFiles(files: MediaFile[], excludedPaths: string[]): MediaFile[] {
  if (excludedPaths.length === 0) return files
  return files.filter((f) => !isFileExcluded(f, excludedPaths))
}

export function toggleExcludedPath(excludedPaths: string[], path: string): string[] {
  if (excludedPaths.includes(path)) {
    return excludedPaths.filter((p) => p !== path)
  }
  // Retirer les exclusions enfants devenues redondantes
  const withoutChildren = excludedPaths.filter(
    (p) => p !== path && !p.startsWith(`${path}/`),
  )
  return [...withoutChildren, path]
}
