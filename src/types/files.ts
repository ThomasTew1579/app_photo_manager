export interface MediaFile {
  id: string
  name: string
  path: string
  relativePath: string
  size: number
  type: 'image' | 'video' | 'other'
  mimeType: string
  lastModified: number
  handle: FileSystemFileHandle
  parentPath: string
}

export interface DirectoryNode {
  name: string
  path: string
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

export type AppTab = 'analyse' | 'hierarchie' | 'doublons' | 'organiser'
