<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type {
  DuplicateGroup,
  DuplicateSortMode,
  DuplicateTagKind,
  MediaFile,
} from '../types/files'
import {
  createPreviewUrl,
  deleteMediaFiles,
  DuplicateScanAbortedError,
  findDuplicateImages,
  sortDuplicateGroups,
} from '../services/duplicates'
import { formatSize } from '../services/scanner'

const TAG_FILTERS: Array<{ kind: DuplicateTagKind; label: string }> = [
  { kind: 'rafale', label: 'Rafale' },
  { kind: 'taille', label: 'Tailles différentes' },
  { kind: 'exact', label: 'Hash identique' },
  { kind: 'fiable', label: 'Doublon probable' },
]

const props = defineProps<{
  files: MediaFile[]
  rootHandle: FileSystemDirectoryHandle | null
  /** Groupes précalculés en tâche de fond (App). */
  backgroundGroups?: DuplicateGroup[] | null
  backgroundLoading?: boolean
  backgroundProgress?: { done: number; total: number }
}>()

const emit = defineEmits<{
  deleted: []
  stop: []
}>()

const groups = ref<DuplicateGroup[]>([])
const loading = ref(false)
const deleting = ref(false)
const progress = ref({ done: 0, total: 0 })
const threshold = ref(2)
const sortMode = ref<DuplicateSortMode>('pertinence')
const viewMode = ref<'liste' | 'grille'>('liste')
const activeTagFilters = ref<DuplicateTagKind[]>([])
const previews = ref<Record<string, string>>({})
const selected = ref<Record<string, boolean>>({})
const error = ref('')
const deleteMessage = ref('')
/** Espace cumulé libéré lors des suppressions de cette session d’analyse. */
const savedBytesTotal = ref(0)
const usedBackground = ref(false)
let manualAbort: AbortController | null = null

const isBusy = computed(() => loading.value || !!props.backgroundLoading)

const filteredGroups = computed(() => {
  if (activeTagFilters.value.length === 0) return groups.value
  return groups.value.filter((g) =>
    activeTagFilters.value.some((kind) => g.tags.some((t) => t.kind === kind)),
  )
})

const sortedGroups = computed(() =>
  sortDuplicateGroups(filteredGroups.value, sortMode.value),
)

const tagCounts = computed(() => {
  const counts: Record<DuplicateTagKind, number> = {
    rafale: 0,
    taille: 0,
    exact: 0,
    fiable: 0,
  }
  for (const group of groups.value) {
    for (const tag of group.tags) {
      counts[tag.kind] += 1
    }
  }
  return counts
})

const selectedFiles = computed(() => {
  const list: MediaFile[] = []
  for (const group of groups.value) {
    for (const file of group.files) {
      if (selected.value[file.id]) list.push(file)
    }
  }
  return list
})

const selectedCount = computed(() => selectedFiles.value.length)

const selectedBytes = computed(() =>
  selectedFiles.value.reduce((sum, f) => sum + f.size, 0),
)

function isTagFilterActive(kind: DuplicateTagKind): boolean {
  return activeTagFilters.value.includes(kind)
}

function toggleTagFilter(kind: DuplicateTagKind) {
  if (isTagFilterActive(kind)) {
    activeTagFilters.value = activeTagFilters.value.filter((k) => k !== kind)
  } else {
    activeTagFilters.value = [...activeTagFilters.value, kind]
  }
}

function clearTagFilters() {
  activeTagFilters.value = []
}

async function loadAllPreviews(nextGroups: DuplicateGroup[]) {
  for (const group of nextGroups) {
    for (const file of group.files) {
      if (previews.value[file.id]) continue
      try {
        previews.value[file.id] = await createPreviewUrl(file)
      } catch {
        /* ignore */
      }
    }
  }
}

/** Met à jour les groupes sans effacer les sélections en cours. */
async function mergeGroups(next: DuplicateGroup[], opts: { resetSelection?: boolean } = {}) {
  groups.value = next
  if (opts.resetSelection) {
    selected.value = {}
    activeTagFilters.value = []
    revokePreviews()
  } else {
    // Ne garde que les sélections toujours présentes
    const alive = new Set(next.flatMap((g) => g.files.map((f) => f.id)))
    const kept: Record<string, boolean> = {}
    for (const [id, on] of Object.entries(selected.value)) {
      if (on && alive.has(id)) kept[id] = true
    }
    selected.value = kept
  }
  await loadAllPreviews(next)
}

watch(
  () => props.backgroundGroups,
  async (next) => {
    if (next && !loading.value) {
      usedBackground.value = true
      await mergeGroups(next)
    }
  },
  { immediate: true },
)

watch(
  () => props.backgroundProgress,
  (p) => {
    if (p && props.backgroundLoading) progress.value = p
  },
)

async function scan() {
  manualAbort?.abort()
  const ac = new AbortController()
  manualAbort = ac
  loading.value = true
  usedBackground.value = false
  error.value = ''
  deleteMessage.value = ''
  groups.value = []
  selected.value = {}
  savedBytesTotal.value = 0
  activeTagFilters.value = []
  revokePreviews()
  try {
    const next = await findDuplicateImages(props.files, {
      threshold: threshold.value,
      partialEvery: 40,
      concurrency: 4,
      signal: ac.signal,
      persistRoot: props.rootHandle ?? undefined,
      onProgress: (done, total) => {
        progress.value = { done, total }
      },
      onPartial: async (partial) => {
        await mergeGroups(partial)
      },
    })
    await mergeGroups(next)
  } catch (e) {
    if (e instanceof DuplicateScanAbortedError) {
      await mergeGroups(e.groups)
      deleteMessage.value = `Analyse interrompue — ${e.groups.length} groupe(s) conservé(s).`
    } else {
      error.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    loading.value = false
    if (manualAbort === ac) manualAbort = null
  }
}

function stopScan() {
  if (loading.value) {
    manualAbort?.abort()
  }
  if (props.backgroundLoading) {
    emit('stop')
  }
}

function isSelected(fileId: string): boolean {
  return !!selected.value[fileId]
}

function toggleFile(fileId: string) {
  selected.value = { ...selected.value, [fileId]: !selected.value[fileId] }
}

function selectKeepOne(group: DuplicateGroup, prefer: 'largest' | 'smallest') {
  const keep =
    prefer === 'largest'
      ? group.files.reduce((best, f) => (f.size > best.size ? f : best))
      : group.files.reduce((best, f) => (f.size < best.size ? f : best))
  const next = { ...selected.value }
  for (const file of group.files) {
    next[file.id] = file.id !== keep.id
  }
  selected.value = next
}

function clearSelection() {
  selected.value = {}
}

async function deleteSelected() {
  if (!props.rootHandle) {
    error.value = 'Aucun répertoire ouvert en écriture.'
    return
  }
  if (selectedCount.value === 0) return

  const toDelete = [...selectedFiles.value]
  const bytesToFree = toDelete.reduce((sum, f) => sum + f.size, 0)

  for (const group of groups.value) {
    const marked = group.files.filter((f) => selected.value[f.id])
    if (marked.length >= group.files.length) {
      error.value =
        'Impossible de supprimer toutes les photos d’un groupe. Gardez-en au moins une.'
      return
    }
  }

  if (
    !confirm(
      `Supprimer définitivement ${toDelete.length} photo(s) sélectionnée(s) (${formatSize(bytesToFree)}) ? Cette action est irréversible.`,
    )
  ) {
    return
  }

  deleting.value = true
  error.value = ''
  deleteMessage.value = ''
  try {
    const result = await deleteMediaFiles(props.rootHandle, toDelete)
    const deletedSet = new Set(result.deleted)
    const freed = toDelete
      .filter((f) => deletedSet.has(f.relativePath))
      .reduce((sum, f) => sum + f.size, 0)
    savedBytesTotal.value += freed

    deleteMessage.value = `${result.deleted.length} fichier(s) supprimé(s) · ${formatSize(freed)} libéré(s) · total session ${formatSize(savedBytesTotal.value)}.`
    if (result.errors.length) {
      error.value = result.errors.join('\n')
    }

    const deletedIds = deletedSet
    for (const group of groups.value) {
      for (const file of group.files) {
        if (deletedIds.has(file.relativePath)) {
          const url = previews.value[file.id]
          if (url) URL.revokeObjectURL(url)
          delete previews.value[file.id]
        }
      }
    }

    groups.value = groups.value
      .map((g) => ({
        ...g,
        files: g.files.filter((f) => !deletedIds.has(f.relativePath)),
      }))
      .filter((g) => g.files.length > 1)

    const alive = new Set(groups.value.flatMap((g) => g.files.map((f) => f.id)))
    const kept: Record<string, boolean> = {}
    for (const [id, on] of Object.entries(selected.value)) {
      if (on && alive.has(id)) kept[id] = true
    }
    selected.value = kept
    emit('deleted')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value = false
  }
}

function revokePreviews() {
  for (const url of Object.values(previews.value)) {
    URL.revokeObjectURL(url)
  }
  previews.value = {}
}

watch(
  () => props.files,
  () => {
    groups.value = []
    selected.value = {}
    savedBytesTotal.value = 0
    activeTagFilters.value = []
    revokePreviews()
  },
)

onBeforeUnmount(() => {
  manualAbort?.abort()
  revokePreviews()
})
</script>

<template>
  <section class="dupes">
    <header class="dupes-header">
      <div>
        <h2>Trieur de doublons</h2>
        <p>
          Analyse visuelle (average hash), y compris HEIC/HEIF et RAW (ARW via JPEG embarqué).
          Tags colorés pour signaler les rafales (noms proches ou numéros qui se suivent).
          <span v-if="backgroundLoading"> Analyse en arrière-plan…</span>
          <span v-else-if="usedBackground && groups.length"> Résultats auto (seuil 2).</span>
        </p>
      </div>
      <div class="controls">
        <label>
          Seuil de similarité
          <input v-model.number="threshold" type="range" min="0" max="12" />
          <span>{{ threshold }}</span>
        </label>
        <button type="button" class="btn primary" :disabled="isBusy || !files.length" @click="scan">
          {{
            isBusy
              ? `Analyse… ${progress.done}/${progress.total}`
              : 'Relancer l’analyse'
          }}
        </button>
        <button
          v-if="isBusy"
          type="button"
          class="btn danger"
          @click="stopScan"
        >
          Arrêter
        </button>
      </div>
    </header>

    <div v-if="groups.length" class="toolbar">
      <div class="toolbar-left">
        <label class="sort">
          Trier par
          <select v-model="sortMode">
            <option value="pertinence">Pertinence</option>
            <option value="tag">Tag (rafale d’abord)</option>
            <option value="taille-groupe">Taille du groupe</option>
          </select>
        </label>
        <div class="view-toggle" role="group" aria-label="Mode d’affichage">
          <button
            type="button"
            class="btn small"
            :class="{ active: viewMode === 'liste' }"
            @click="viewMode = 'liste'"
          >
            Liste
          </button>
          <button
            type="button"
            class="btn small"
            :class="{ active: viewMode === 'grille' }"
            @click="viewMode = 'grille'"
          >
            Grille
          </button>
        </div>
      </div>
      <div class="toolbar-actions">
        <div class="memory-stats" aria-live="polite">
          <span v-if="selectedCount" class="memory-pending">
            Mémoire à gagner : <strong>{{ formatSize(selectedBytes) }}</strong>
            ({{ selectedCount }} fichier{{ selectedCount > 1 ? 's' : '' }})
          </span>
          <span v-else class="memory-pending muted">Mémoire à gagner : —</span>
          <span v-if="savedBytesTotal > 0" class="memory-saved">
            Déjà libéré : <strong>{{ formatSize(savedBytesTotal) }}</strong>
          </span>
        </div>
        <button type="button" class="btn" :disabled="!selectedCount" @click="clearSelection">
          Tout désélectionner
        </button>
        <button
          type="button"
          class="btn danger"
          :disabled="!selectedCount || deleting || !rootHandle"
          @click="deleteSelected"
        >
          {{
            deleting
              ? 'Suppression…'
              : selectedCount
                ? `Supprimer (${selectedCount} · ${formatSize(selectedBytes)})`
                : 'Supprimer'
          }}
        </button>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="deleteMessage" class="ok">{{ deleteMessage }}</p>

    <p v-if="!loading && groups.length === 0 && progress.total > 0" class="empty">
      Aucun doublon détecté avec ce seuil.
    </p>

    <div class="legend" v-if="groups.length">
      <span class="hint-select">Cases cochées = fichiers à supprimer</span>
      <span class="filter-label">Filtrer :</span>
      <button
        v-for="tag in TAG_FILTERS"
        :key="tag.kind"
        type="button"
        class="tag filter-tag"
        :class="[`tag-${tag.kind}`, { active: isTagFilterActive(tag.kind) }]"
        :aria-pressed="isTagFilterActive(tag.kind)"
        @click="toggleTagFilter(tag.kind)"
      >
        {{ tag.label }}
        <span class="tag-count">{{ tagCounts[tag.kind] }}</span>
      </button>
      <button
        v-if="activeTagFilters.length"
        type="button"
        class="btn small"
        @click="clearTagFilters"
      >
        Effacer filtres
      </button>
      <span v-if="activeTagFilters.length" class="filter-summary">
        {{ sortedGroups.length }} / {{ groups.length }} groupe{{ groups.length > 1 ? 's' : '' }}
      </span>
    </div>

    <p
      v-if="groups.length && !sortedGroups.length && activeTagFilters.length"
      class="empty"
    >
      Aucun groupe ne correspond aux tags sélectionnés.
    </p>

    <div v-if="sortedGroups.length" class="groups">
      <article v-for="(group, idx) in sortedGroups" :key="group.id" class="group">
        <div class="group-head">
          <div class="group-title">
            <h3>
              Groupe {{ idx + 1 }} · {{ group.files.length }} fichiers · pertinence
              {{ group.relevance }}%
            </h3>
            <div class="tags">
              <span
                v-for="tag in group.tags"
                :key="tag.kind"
                class="tag"
                :class="`tag-${tag.kind}`"
              >
                {{ tag.label }}
              </span>
            </div>
          </div>
          <div class="group-actions">
            <button
              type="button"
              class="btn small"
              title="Conserve la plus lourde ; coche les autres pour suppression"
              @click="selectKeepOne(group, 'largest')"
            >
              Garder la plus lourde
            </button>
            <button
              type="button"
              class="btn small"
              title="Conserve la plus légère ; coche les autres pour suppression"
              @click="selectKeepOne(group, 'smallest')"
            >
              Garder la plus légère
            </button>
          </div>
        </div>

        <ul v-if="viewMode === 'liste'">
          <li v-for="file in group.files" :key="file.id">
            <label class="row">
              <input
                type="checkbox"
                :checked="isSelected(file.id)"
                @change="toggleFile(file.id)"
              />
              <img
                v-if="previews[file.id]"
                :src="previews[file.id]"
                :alt="file.name"
                class="thumb-sm"
              />
              <span class="path">{{ file.relativePath }}</span>
              <span class="meta">{{ formatSize(file.size) }}</span>
            </label>
          </li>
        </ul>

        <div v-else class="grid">
          <label
            v-for="file in group.files"
            :key="file.id"
            class="grid-card"
            :class="{ checked: isSelected(file.id) }"
          >
            <input
              type="checkbox"
              class="grid-check"
              :checked="isSelected(file.id)"
              @change="toggleFile(file.id)"
            />
            <div class="grid-thumb">
              <img
                v-if="previews[file.id]"
                :src="previews[file.id]"
                :alt="file.name"
              />
              <span v-else class="grid-placeholder">Aperçu</span>
            </div>
            <span class="grid-name" :title="file.relativePath">{{ file.name }}</span>
            <span class="grid-meta">{{ formatSize(file.size) }}</span>
          </label>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.dupes {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.dupes-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-end;
}

.dupes-header h2 {
  margin: 0 0 0.35rem;
  font-size: 1.25rem;
}

.dupes-header p {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
}

.controls,
.toolbar,
.toolbar-left {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
}

.toolbar {
  justify-content: space-between;
  padding: 0.75rem 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.view-toggle {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.memory-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  align-items: baseline;
  font-size: 0.85rem;
  margin-right: 0.25rem;
}

.memory-pending strong,
.memory-saved strong {
  font-variant-numeric: tabular-nums;
}

.memory-pending strong {
  color: var(--accent);
}

.memory-saved {
  color: var(--accent);
}

.memory-pending.muted {
  color: var(--muted);
}

.view-toggle .btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #f7fffb;
}

.controls label,
.sort {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--muted);
}

select {
  font: inherit;
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.hint-select {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--danger);
  margin-right: 0.5rem;
}

.filter-label {
  font-size: 0.8rem;
  color: var(--muted);
  font-weight: 600;
}

.filter-summary {
  font-size: 0.8rem;
  color: var(--muted);
}

.filter-tag {
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}

.filter-tag:hover {
  opacity: 0.85;
}

.filter-tag.active {
  opacity: 1;
  box-shadow: 0 0 0 2px currentColor;
  transform: translateY(-1px);
}

.tag-count {
  margin-left: 0.35rem;
  font-weight: 700;
  opacity: 0.85;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.45rem;
}

.tag {
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.tag-rafale {
  background: #fff0c2;
  color: #8a5a00;
  border: 1px solid #e0b84a;
}

.tag-taille {
  background: #ffe4d6;
  color: #9a3b12;
  border: 1px solid #e09a6a;
}

.tag-exact {
  background: #d9f0e8;
  color: #145c48;
  border: 1px solid #7cbca8;
}

.tag-fiable {
  background: #ddeeff;
  color: #1a4f8a;
  border: 1px solid #7aa8d8;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.group {
  padding: 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.group-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.group-title h3 {
  margin: 0;
  font-size: 1rem;
}

.group-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.btn.small {
  padding: 0.4rem 0.7rem;
  font-size: 0.8rem;
}

.btn.danger {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff8f6;
}

.btn.danger:hover:not(:disabled) {
  filter: brightness(0.92);
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  font-size: 0.9rem;
  cursor: pointer;
}

.thumb-sm {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.path {
  flex: 1;
  word-break: break-all;
}

.meta {
  color: var(--muted);
  white-space: nowrap;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.75rem;
}

.grid-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.grid-card:hover {
  border-color: var(--accent);
}

.grid-card.checked {
  border-color: var(--danger);
  box-shadow: 0 0 0 1px var(--danger);
  background: #fff5f2;
}

.grid-check {
  position: absolute;
  top: 0.65rem;
  left: 0.65rem;
  z-index: 1;
}

.grid-thumb {
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-hover);
  display: grid;
  place-items: center;
}

.grid-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.grid-placeholder {
  font-size: 0.75rem;
  color: var(--muted);
}

.grid-name {
  font-size: 0.78rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-meta {
  font-size: 0.72rem;
  color: var(--muted);
}

.empty,
.error,
.ok {
  margin: 0;
  white-space: pre-wrap;
}

.error {
  color: var(--danger);
}

.ok {
  color: var(--accent);
}
</style>
