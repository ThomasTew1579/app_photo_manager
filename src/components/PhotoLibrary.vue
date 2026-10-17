<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LibrarySortMode, MediaFile } from '../types/files'
import { createPreviewUrl } from '../services/duplicates'
import { formatDate, formatSize } from '../services/scanner'

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]

const props = defineProps<{
  files: MediaFile[]
  sourceLabel: string
}>()

const sortMode = ref<LibrarySortMode>('date-desc')
const filterType = ref<'all' | 'image' | 'video'>('all')
const previews = ref<Record<string, string>>({})
const loadingPreviews = ref(false)
const selectedId = ref<string | null>(null)
const viewerUrl = ref<string | null>(null)
const scrollRoot = ref<HTMLElement | null>(null)
const scrollDateLabel = ref('')

interface LibrarySection {
  key: string
  year: number
  month: number
  yearLabel: string
  monthLabel: string
  files: MediaFile[]
  showYear: boolean
}

const mediaFiles = computed(() =>
  props.files.filter((f) => f.type === 'image' || f.type === 'video'),
)

const filtered = computed(() => {
  let list = mediaFiles.value
  if (filterType.value !== 'all') {
    list = list.filter((f) => f.type === filterType.value)
  }
  const sorted = [...list]
  switch (sortMode.value) {
    case 'date-asc':
      sorted.sort((a, b) => a.createdAt - b.createdAt)
      break
    case 'date-desc':
      sorted.sort((a, b) => b.createdAt - a.createdAt)
      break
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      break
    case 'size':
      sorted.sort((a, b) => b.size - a.size)
      break
    case 'type':
      sorted.sort((a, b) => a.type.localeCompare(b.type) || b.createdAt - a.createdAt)
      break
  }
  return sorted
})

const sections = computed(() => {
  const map = new Map<string, Omit<LibrarySection, 'showYear'>>()
  for (const file of filtered.value) {
    const d = new Date(file.createdAt)
    const year = d.getFullYear()
    const month = d.getMonth()
    const key = `${year}-${month}`
    let section = map.get(key)
    if (!section) {
      section = {
        key,
        year,
        month,
        yearLabel: String(year),
        monthLabel: MONTHS_FR[month],
        files: [],
      }
      map.set(key, section)
    }
    section.files.push(file)
  }
  const list = [...map.values()]
  if (sortMode.value === 'date-asc') {
    list.sort((a, b) => a.year - b.year || a.month - b.month)
  } else {
    list.sort((a, b) => b.year - a.year || b.month - a.month)
  }
  return list.map((s, i) => ({
    ...s,
    showYear: i === 0 || list[i - 1].year !== s.year,
  }))
})

const selected = computed(() =>
  filtered.value.find((f) => f.id === selectedId.value) ?? null,
)

function formatScrollDate(ts: number): string {
  const d = new Date(ts)
  return `${MONTHS_FR[d.getMonth()]} ${d.getFullYear()}`
}

async function ensurePreview(file: MediaFile) {
  if (previews.value[file.id] || file.type === 'video') return
  try {
    previews.value[file.id] = await createPreviewUrl(file)
  } catch {
    /* ignore */
  }
}

async function loadVisiblePreviews() {
  loadingPreviews.value = true
  const batch = 24
  for (let i = 0; i < filtered.value.length; i += batch) {
    const slice = filtered.value.slice(i, i + batch)
    await Promise.all(slice.map((f) => ensurePreview(f)))
  }
  loadingPreviews.value = false
}

async function openViewer(file: MediaFile) {
  selectedId.value = file.id
  if (viewerUrl.value) URL.revokeObjectURL(viewerUrl.value)
  viewerUrl.value = null
  try {
    if (file.type === 'image') {
      await ensurePreview(file)
      viewerUrl.value = previews.value[file.id] ?? null
    } else {
      const blob = await file.handle.getFile()
      viewerUrl.value = URL.createObjectURL(blob)
    }
  } catch {
    viewerUrl.value = null
  }
}

function closeViewer() {
  selectedId.value = null
  if (viewerUrl.value && !Object.values(previews.value).includes(viewerUrl.value)) {
    URL.revokeObjectURL(viewerUrl.value)
  }
  viewerUrl.value = null
}

function revokeAll() {
  for (const url of Object.values(previews.value)) URL.revokeObjectURL(url)
  previews.value = {}
  if (viewerUrl.value) {
    URL.revokeObjectURL(viewerUrl.value)
    viewerUrl.value = null
  }
}

function updateScrollDate() {
  const root = scrollRoot.value
  if (!root) return
  const tiles = root.querySelectorAll<HTMLElement>('[data-created-at]')
  if (!tiles.length) {
    scrollDateLabel.value = ''
    return
  }
  const rootTop = root.getBoundingClientRect().top
  let best: HTMLElement | null = null
  let bestDist = Infinity
  for (const tile of tiles) {
    const rect = tile.getBoundingClientRect()
    // Première ligne visible : haut de tuile juste sous le header sticky (~0–160px dans le viewport du scroll)
    if (rect.bottom <= rootTop + 8) continue
    const dist = Math.abs(rect.top - rootTop)
    if (dist < bestDist) {
      bestDist = dist
      best = tile
    }
    // Dès qu'on a dépassé la première rangée, on peut s'arrêter
    if (rect.top > rootTop + 180) break
  }
  if (!best) best = tiles[0]
  const ts = Number(best.dataset.createdAt)
  scrollDateLabel.value = Number.isFinite(ts) ? formatScrollDate(ts) : ''
}

let scrollRaf = 0
function onScroll() {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    updateScrollDate()
  })
}

watch(
  () => props.files,
  () => {
    revokeAll()
    selectedId.value = null
    void loadVisiblePreviews().then(() => nextTick(updateScrollDate))
  },
  { immediate: true },
)

watch([sortMode, filterType, sections], () => {
  void loadVisiblePreviews().then(() => nextTick(updateScrollDate))
})

onMounted(() => {
  scrollRoot.value?.addEventListener('scroll', onScroll, { passive: true })
  nextTick(updateScrollDate)
})

onBeforeUnmount(() => {
  scrollRoot.value?.removeEventListener('scroll', onScroll)
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  revokeAll()
})
</script>

<template>
  <section class="library">
    <header class="library-top">
      <div class="title-row">
        <div>
          <p class="eyebrow">Bibliothèque</p>
          <h1>
            <span class="source">{{ sourceLabel }}</span>
            <span v-if="scrollDateLabel" class="scroll-date" aria-live="polite">{{
              scrollDateLabel
            }}</span>
          </h1>
          <p class="meta">
            {{ filtered.length }} élément{{ filtered.length > 1 ? 's' : '' }}
            <span v-if="loadingPreviews"> · chargement des aperçus…</span>
          </p>
        </div>
      </div>
      <div class="toolbar">
        <div class="segmented" role="group" aria-label="Type">
          <button type="button" :class="{ active: filterType === 'all' }" @click="filterType = 'all'">
            Tout
          </button>
          <button
            type="button"
            :class="{ active: filterType === 'image' }"
            @click="filterType = 'image'"
          >
            Photos
          </button>
          <button
            type="button"
            :class="{ active: filterType === 'video' }"
            @click="filterType = 'video'"
          >
            Vidéos
          </button>
        </div>
        <label class="sort">
          Trier
          <select v-model="sortMode">
            <option value="date-desc">Plus récentes</option>
            <option value="date-asc">Plus anciennes</option>
            <option value="name">Nom</option>
            <option value="size">Taille</option>
            <option value="type">Type</option>
          </select>
        </label>
      </div>
    </header>

    <div v-if="sections.length" ref="scrollRoot" class="library-scroll">
      <section v-for="section in sections" :key="section.key" class="month-block">
        <h2 class="section-label">
          <span v-if="section.showYear" class="year-part">{{ section.yearLabel }}</span>
          <span class="month-part">{{ section.monthLabel }}</span>
        </h2>
        <div class="photo-grid">
          <button
            v-for="file in section.files"
            :key="file.id"
            type="button"
            class="tile"
            :class="{ selected: selectedId === file.id }"
            :data-created-at="file.createdAt"
            :title="file.relativePath"
            @click="openViewer(file)"
          >
            <img
              v-if="previews[file.id]"
              :src="previews[file.id]"
              :alt="file.name"
              loading="lazy"
            />
            <div v-else class="tile-fallback" :class="file.type">
              <span>{{ file.type === 'video' ? '▶' : '◻' }}</span>
            </div>
            <span v-if="file.type === 'video'" class="badge">Vidéo</span>
          </button>
        </div>
      </section>
    </div>
    <p v-else class="empty">Aucun média à afficher.</p>

    <div v-if="selected" class="viewer" @click.self="closeViewer">
      <div class="viewer-panel">
        <header class="viewer-head">
          <div>
            <h2>{{ selected.name }}</h2>
            <p>
              {{ formatDate(selected.createdAt) }} · {{ formatSize(selected.size) }} ·
              {{ selected.relativePath }}
            </p>
          </div>
          <button type="button" class="btn ghost" @click="closeViewer">Fermer</button>
        </header>
        <div class="viewer-body">
          <img v-if="selected.type === 'image' && viewerUrl" :src="viewerUrl" :alt="selected.name" />
          <video v-else-if="selected.type === 'video' && viewerUrl" :src="viewerUrl" controls />
          <p v-else class="empty">Aperçu indisponible</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.library {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  height: calc(100vh - 4.5rem);
  min-height: 320px;
}

.library-top {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-end;
  flex-shrink: 0;
}

.eyebrow {
  margin: 0;
  font-size: 0.8rem;
  color: var(--muted);
  font-weight: 600;
}

.library-top h1 {
  margin: 0.15rem 0 0.25rem;
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.65rem 1rem;
}

.scroll-date {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: -0.01em;
}

.meta {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}

.segmented {
  display: inline-flex;
  padding: 2px;
  background: var(--fill-secondary);
  border-radius: 8px;
}

.segmented button {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0.4rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
}

.segmented button.active {
  background: #48484a;
  box-shadow: 0 0.5px 2px rgba(0, 0, 0, 0.35);
}

.sort {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.85rem;
  color: var(--muted);
}

.sort select {
  font: inherit;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 8px;
  padding: 0.4rem 0.55rem;
  color: var(--text);
}

.library-scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding-right: 0.15rem;
}

.month-block {
  margin-bottom: 1.5rem;
}

.section-label {
  position: sticky;
  top: 0;
  z-index: 2;
  margin: 0 0 0.55rem;
  padding: 0.45rem 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.85rem;
  align-items: baseline;
  background: linear-gradient(var(--bg) 70%, transparent);
  font-size: 1rem;
}

.year-part {
  font-weight: 700;
  font-size: 1.35rem;
  letter-spacing: -0.03em;
}

.month-part {
  font-weight: 600;
  color: var(--muted);
  text-transform: capitalize;
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 3px;
  background: var(--bg);
}

.tile {
  position: relative;
  aspect-ratio: 1;
  border: none;
  padding: 0;
  overflow: hidden;
  cursor: pointer;
  background: var(--fill-secondary);
}

.tile img,
.tile-fallback {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.tile-fallback {
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 1.4rem;
}

.tile-fallback.video {
  background: #000;
  color: #fff;
}

.tile.selected {
  outline: 3px solid var(--accent);
  outline-offset: -3px;
}

.badge {
  position: absolute;
  left: 6px;
  bottom: 6px;
  font-size: 0.65rem;
  font-weight: 700;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
}

.viewer {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.72);
  display: grid;
  place-items: center;
  padding: 1.5rem;
}

.viewer-panel {
  width: min(960px, 100%);
  max-height: 90vh;
  background: var(--surface);
  border-radius: 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
}

.viewer-head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.15rem;
  border-bottom: 1px solid var(--border);
}

.viewer-head h2 {
  margin: 0;
  font-size: 1.05rem;
}

.viewer-head p {
  margin: 0.25rem 0 0;
  color: var(--muted);
  font-size: 0.8rem;
  word-break: break-all;
}

.viewer-body {
  flex: 1;
  min-height: 280px;
  display: grid;
  place-items: center;
  background: #000;
  padding: 0.75rem;
}

.viewer-body img,
.viewer-body video {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
}

.empty {
  margin: 2rem 0;
  text-align: center;
  color: var(--muted);
}
</style>
