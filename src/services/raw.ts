/** Extensions RAW courantes (Sony ARW + proches TIFF/JPEG embarqué). */
const RAW_EXT = new Set([
  '.arw', // Sony
  '.cr2',
  '.cr3', // Canon
  '.nef', // Nikon
  '.dng', // Adobe
  '.raf', // Fuji
  '.rw2', // Panasonic
  '.orf', // Olympus
  '.pef', // Pentax
  '.srw', // Samsung
])

export function isRawLike(name: string, mimeType = ''): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return (
    RAW_EXT.has(ext) ||
    mimeType === 'image/x-sony-arw' ||
    mimeType === 'image/x-canon-cr2' ||
    mimeType === 'image/x-nikon-nef' ||
    mimeType === 'image/x-adobe-dng'
  )
}

/**
 * Les navigateurs ne décodent pas les RAW.
 * On extrait le plus grand JPEG embarqué (aperçu / thumbnail),
 * présent dans la quasi-totalité des ARW Sony et la plupart des autres RAW.
 */
export async function extractEmbeddedJpeg(file: Blob): Promise<Blob | null> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  let bestStart = -1
  let bestLen = 0
  const minJpegSize = 8_000
  const maxJpegSize = 20_000_000

  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xd8) continue

    const limit = Math.min(bytes.length - 1, i + maxJpegSize)
    for (let j = i + 3; j < limit; j++) {
      if (bytes[j] !== 0xff || bytes[j + 1] !== 0xd9) continue
      const len = j + 2 - i
      if (len >= minJpegSize && len > bestLen) {
        bestStart = i
        bestLen = len
      }
      i = j + 1
      break
    }
  }

  if (bestStart < 0) return null
  return new Blob([bytes.subarray(bestStart, bestStart + bestLen)], { type: 'image/jpeg' })
}
