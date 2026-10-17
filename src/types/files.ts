export interface MediaFile {
  id: string
  name: string
  path: string
  relativePath: string
  size: number
  type: 'image' | 'video' | 'other'
  mimeType: string
  /** Date de modification FS actuelle. */
  lastModified: number
  /**
   * Date de création logique : EXIF, sinon meta JSON (origine),
   * sinon la plus ancienne entre mtime JSON d’origine et mtime FS.
   */
  createdAt: number
  /** lastModified d’origine issu du JSON app (si connu). */
  originalLastModified?: number
  /** aHash mis en cache (JSON ou calcul doublons). */
  aHash?: string
  handle: FileSystemFileHandle
  parentPath: string
}

export interface DirectoryNode {
  name: string
  path: string
  /** Chemin relatif à la racine sélectionnée (sans le nom racine). */
  relativePath: string
  fileCount: number
  imageCount: number
  videoCount: number
  totalSize: number
  children: DirectoryNode[]
  files: MediaFile[]
}

export interface AnalysisReport {
  rootName: string
  scannedAt: Date
  totalFiles: number
  totalImages: number
  totalVideos: number
  totalOthers: number
  totalSize: number
  directoryCount: number
  tree: DirectoryNode
  files: MediaFile[]
}

/** Tags colorés pour signaler le type / risque d’un groupe de doublons. */
export type DuplicateTagKind = 'rafale' | 'fiable' | 'exact' | 'taille'

export interface DuplicateTag {
  kind: DuplicateTagKind
  label: string
}

export interface DuplicateGroup {
  id: string
  hash: string
  files: MediaFile[]
  tags: DuplicateTag[]
  /** Score 0–100 : plus élevé = doublon plus probable / pertinent à traiter. */
  relevance: number
  previewUrl?: string
}

export type DuplicateSortMode = 'pertinence' | 'tag' | 'taille-groupe'

export type AppTab = 'bibliotheque' | 'analyse' | 'hierarchie' | 'doublons' | 'organiser'

export type LibrarySortMode = 'date-desc' | 'date-asc' | 'name' | 'size' | 'type'

export type SourceKind = 'device' | 'folder'
