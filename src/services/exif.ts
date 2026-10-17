/**
 * Lit DateTimeOriginal / DateTime EXIF (JPEG) si présent.
 * Retourne un timestamp ms, ou null.
 */
export async function extractExifCreatedAt(file: Blob): Promise<number | null> {
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())
  if (head.length < 12 || head[0] !== 0xff || head[1] !== 0xd8) return null

  let offset = 2
  while (offset + 4 < head.length) {
    if (head[offset] !== 0xff) break
    const marker = head[offset + 1]
    const size = (head[offset + 2] << 8) | head[offset + 3]
    if (marker === 0xe1 && offset + 4 + size <= head.length) {
      const segment = head.subarray(offset + 4, offset + 2 + size)
      const date = parseExifSegment(segment)
      if (date != null) return date
    }
    if (size < 2) break
    offset += 2 + size
    if (marker === 0xda) break // SOS
  }
  return null
}

function parseExifSegment(segment: Uint8Array): number | null {
  // "Exif\0\0"
  if (segment.length < 14) return null
  const isExif =
    segment[0] === 0x45 &&
    segment[1] === 0x78 &&
    segment[2] === 0x69 &&
    segment[3] === 0x66
  if (!isExif) return null

  const tiff = segment.subarray(6)
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  const get16 = (o: number) =>
    little ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]
  const get32 = (o: number) =>
    little
      ? tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)
      : (tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]

  if (get16(2) !== 42) return null
  const ifd0 = get32(4)
  const fromIfd0 = readDateFromIfd(tiff, ifd0, little, get16, get32)
  if (fromIfd0 != null) return fromIfd0

  // Cherche Exif IFD (tag 0x8769)
  const exifOffset = findTagOffset(tiff, ifd0, little, get16, get32, 0x8769)
  if (exifOffset != null) {
    return readDateFromIfd(tiff, exifOffset, little, get16, get32)
  }
  return null
}

function findTagOffset(
  tiff: Uint8Array,
  ifdOffset: number,
  _little: boolean,
  get16: (o: number) => number,
  get32: (o: number) => number,
  tagId: number,
): number | null {
  if (ifdOffset <= 0 || ifdOffset + 2 > tiff.length) return null
  const count = get16(ifdOffset)
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12
    if (entry + 12 > tiff.length) break
    if (get16(entry) === tagId && get16(entry + 2) === 4) {
      return get32(entry + 8)
    }
  }
  return null
}

function readDateFromIfd(
  tiff: Uint8Array,
  ifdOffset: number,
  _little: boolean,
  get16: (o: number) => number,
  get32: (o: number) => number,
): number | null {
  if (ifdOffset <= 0 || ifdOffset + 2 > tiff.length) return null
  const count = get16(ifdOffset)
  // Priorité : DateTimeOriginal (0x9003), DateTimeDigitized (0x9004), DateTime (0x0132)
  const prefer = [0x9003, 0x9004, 0x0132]
  const found = new Map<number, string>()

  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12
    if (entry + 12 > tiff.length) break
    const tag = get16(entry)
    if (!prefer.includes(tag)) continue
    const type = get16(entry + 2)
    const num = get32(entry + 4)
    if (type !== 2 || num < 20) continue
    let valueOffset = entry + 8
    if (num > 4) valueOffset = get32(entry + 8)
    if (valueOffset + 19 > tiff.length) continue
    const raw = String.fromCharCode(...tiff.subarray(valueOffset, valueOffset + 19))
    found.set(tag, raw)
  }

  for (const tag of prefer) {
    const raw = found.get(tag)
    if (!raw) continue
    const ts = parseExifDateString(raw)
    if (ts != null) return ts
  }
  return null
}

/** "YYYY:MM:DD HH:MM:SS" */
function parseExifDateString(raw: string): number | null {
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  )
  const t = d.getTime()
  return Number.isNaN(t) ? null : t
}

export function formatExifDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function isJpegName(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return ext === '.jpg' || ext === '.jpeg'
}

/**
 * Construit un segment APP1 EXIF minimal (little-endian) avec DateTimeOriginal + DateTime.
 */
function buildExifApp1Segment(createdAt: number): Uint8Array {
  const dateStr = `${formatExifDate(createdAt)}\0` // 20 bytes
  const dateBytes = new TextEncoder().encode(dateStr)

  // TIFF layout (after Exif\0\0):
  // 0: II 2A00, IFD0@8
  // 8: IFD0 count=1, tag ExifIFD(0x8769), next=0
  // 26: ExifIFD count=2, DateTimeOriginal + DateTime, next=0
  // 54: date string 20 bytes (shared for both tags via same offset — use two copies for simplicity)
  const exifIfdOffset = 26
  const date1Offset = 54
  const date2Offset = 74
  const tiffLen = 94

  const tiff = new Uint8Array(tiffLen)
  const set16 = (o: number, v: number) => {
    tiff[o] = v & 0xff
    tiff[o + 1] = (v >> 8) & 0xff
  }
  const set32 = (o: number, v: number) => {
    tiff[o] = v & 0xff
    tiff[o + 1] = (v >> 8) & 0xff
    tiff[o + 2] = (v >> 16) & 0xff
    tiff[o + 3] = (v >> 24) & 0xff
  }

  // Header
  tiff[0] = 0x49
  tiff[1] = 0x49
  set16(2, 42)
  set32(4, 8)

  // IFD0 — 1 entry
  set16(8, 1)
  set16(10, 0x8769) // ExifIFDPointer
  set16(12, 4) // LONG
  set32(14, 1)
  set32(18, exifIfdOffset)
  set32(22, 0) // next IFD

  // Exif IFD — 2 entries
  set16(26, 2)
  // DateTimeOriginal 0x9003
  set16(28, 0x9003)
  set16(30, 2) // ASCII
  set32(32, 20)
  set32(36, date1Offset)
  // DateTime 0x0132
  set16(40, 0x0132)
  set16(42, 2)
  set32(44, 20)
  set32(48, date2Offset)
  set32(52, 0) // next

  tiff.set(dateBytes, date1Offset)
  tiff.set(dateBytes, date2Offset)

  const exifHeader = new TextEncoder().encode('Exif\0\0')
  const payloadLen = exifHeader.length + tiff.length
  const app1 = new Uint8Array(4 + payloadLen)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1[2] = ((payloadLen + 2) >> 8) & 0xff
  app1[3] = (payloadLen + 2) & 0xff
  app1.set(exifHeader, 4)
  app1.set(tiff, 4 + exifHeader.length)
  return app1
}

/**
 * Si le JPEG a déjà une date EXIF → bytes inchangés.
 * Sinon → injecte DateTimeOriginal pour survivre au lastModified réécrit par le navigateur.
 */
export async function ensureJpegCreationDate(blob: Blob, createdAt: number): Promise<Blob> {
  const existing = await extractExifCreatedAt(blob)
  if (existing != null) return blob

  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return blob

  const app1 = buildExifApp1Segment(createdAt)
  const out = new Uint8Array(2 + app1.length + (bytes.length - 2))
  out[0] = 0xff
  out[1] = 0xd8
  out.set(app1, 2)
  out.set(bytes.subarray(2), 2 + app1.length)
  return new Blob([out], { type: blob.type || 'image/jpeg' })
}
