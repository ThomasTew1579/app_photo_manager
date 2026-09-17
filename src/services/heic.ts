import { extractEmbeddedJpeg, isRawLike } from './raw'

export function isHeicLike(name: string, mimeType = ''): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return (
    ext === '.heic' ||
    ext === '.heif' ||
    mimeType === 'image/heic' ||
    mimeType === 'image/heif'
  )
}

/**
 * Produit un blob affichable / hashable dans le navigateur :
 * - HEIC/HEIF → JPEG via heic2any
 * - RAW (ARW, …) → JPEG embarqué extrait du fichier
 * - autres → fichier tel quel
 */
export async function toDecodableImageBlob(file: File, name = file.name): Promise<Blob> {
  if (isHeicLike(name, file.type)) {
    const { default: heic2any } = await import('heic2any')
    const result = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.92,
    })
    return Array.isArray(result) ? result[0] : result
  }

  if (isRawLike(name, file.type)) {
    const jpeg = await extractEmbeddedJpeg(file)
    if (!jpeg) {
      throw new Error(`Aucun JPEG embarqué trouvé dans ${name}`)
    }
    return jpeg
  }

  return file
}
