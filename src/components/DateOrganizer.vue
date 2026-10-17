<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MediaFile } from '../types/files'
import {
  buildHierarchyPreview,
  buildOrganizePlan,
  findEmptyDirectories,
  HIERARCHY_OPTIONS,
  NAME_FORMAT_OPTIONS,
  organizeByDate,
  removeEmptyDirectories,
  type DateHierarchyLevel,
  type FileNameFormat,
  type OrganizeResult,
} from '../services/organizer'

const props = defineProps<{
  files: MediaFile[]
  rootHandle: FileSystemDirectoryHandle | null
}>()

const emit = defineEmits<{
  organized: []
}>()

const loading = ref(false)
const cleaning = ref(false)
const progress = ref({ done: 0, total: 0 })
const moveFiles = ref(true)
const hierarchy = ref<DateHierarchyLevel>('day')
const nameFormat = ref<FileNameFormat>('original')
const result = ref<OrganizeResult | null>(null)
const error = ref('')
const emptyDirs = ref<string[]>([])
const emptyCleanupDone = ref(false)
const emptyCleanupMessage = ref('')

const hierarchyMeta = computed(
  () => HIERARCHY_OPTIONS.find((o) => o.value === hierarchy.value) ?? HIERARCHY_OPTIONS[2],
)

const nameFormatMeta = computed(
  () => NAME_FORMAT_OPTIONS.find((o) => o.value === nameFormat.value) ?? NAME_FORMAT_OPTIONS[0],
)

const plan = computed(() =>
  buildOrganizePlan(props.files, hierarchy.value, nameFormat.value),
)

const treePreview = computed(() => buildHierarchyPreview(plan.value))

async function run() {
  if (!props.rootHandle) {
    error.value = 'Aucun répertoire sélectionné.'
    return
  }
  loading.value = true
  error.value = ''
  result.value = null
  emptyDirs.value = []
  emptyCleanupDone.value = false
  emptyCleanupMessage.value = ''
  try {
    result.value = await organizeByDate(props.rootHandle, props.files, {
      move: moveFiles.value,
      level: hierarchy.value,
      nameFormat: nameFormat.value,
      onProgress: (done, total) => {
        progress.value = { done, total }
      },
    })

    const found = await findEmptyDirectories(props.rootHandle)
    if (found.length > 0) {
      emptyDirs.value = found
    } else {
      emptyCleanupMessage.value = 'Aucun répertoire vide détecté.'
      emptyCleanupDone.value = true
      emit('organized')
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function confirmRemoveEmpty() {
  if (!props.rootHandle || emptyDirs.value.length === 0) return
  cleaning.value = true
  error.value = ''
  try {
    const res = await removeEmptyDirectories(props.rootHandle, emptyDirs.value)
    emptyCleanupMessage.value = `${res.removed.length} répertoire(s) vide(s) supprimé(s).`
    if (res.errors.length) {
      error.value = res.errors.join('\n')
    }
    emptyCleanupDone.value = true
    emptyDirs.value = []
    emit('organized')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    cleaning.value = false
  }
}

function skipRemoveEmpty() {
  emptyCleanupMessage.value = 'Répertoires vides conservés.'
  emptyCleanupDone.value = true
  emptyDirs.value = []
  emit('organized')
}
</script>

<template>
  <section class="organizer">
    <header>
      <h2>Organisation par date</h2>
      <p>
        Hiérarchie <strong>année → mois → jour</strong> basée sur la
        <strong>date la plus ancienne</strong> (EXIF / registre / mtime).
        Noms : <code>{{ nameFormatMeta.example }}</code> · dossiers
        <code>{{ hierarchyMeta.example }}</code>
        Les dates d’origine sont préservées (EXIF JPEG +
        <code>_photo_meta.json</code> : createdAt, lastModified, aHash).
      </p>
    </header>

    <div class="options">
      <label class="field">
        Niveau de hiérarchie
        <select v-model="hierarchy">
          <option v-for="opt in HIERARCHY_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <label class="field">
        Nom des fichiers
        <select v-model="nameFormat">
          <option v-for="opt in NAME_FORMAT_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <label class="check">
        <input v-model="moveFiles" type="checkbox" />
        Déplacer les fichiers (sinon copie uniquement)
      </label>
      <button
        type="button"
        class="btn primary"
        :disabled="loading || !rootHandle || !plan.length"
        @click="run"
      >
        {{ loading ? `Organisation… ${progress.done}/${progress.total}` : 'Créer les dossiers &amp; ranger' }}
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="treePreview.length" class="preview">
      <h3>Aperçu hiérarchique ({{ plan.length }} médias)</h3>
      <ul class="tree">
        <li v-for="year in treePreview" :key="year.key" class="tree-year">
          <div class="tree-row">
            <span class="folder">📁 {{ year.name }}</span>
            <span class="count">{{ year.fileCount }} fichier{{ year.fileCount > 1 ? 's' : '' }}</span>
          </div>
          <ul v-if="year.children.length" class="tree-nested">
            <li v-for="month in year.children" :key="month.key" class="tree-month">
              <div class="tree-row">
                <span class="folder">📁 {{ month.name }}</span>
                <span class="count">{{ month.fileCount }}</span>
              </div>
              <ul v-if="month.children.length" class="tree-nested">
                <li v-for="day in month.children" :key="day.key" class="tree-day">
                  <div class="tree-row">
                    <span class="folder">📁 {{ day.name }}</span>
                    <span class="count">{{ day.fileCount }}</span>
                  </div>
                </li>
              </ul>
            </li>
          </ul>
        </li>
      </ul>
    </div>
    <p v-else class="empty">Aucun média à organiser. Lancez d’abord une analyse.</p>

    <div v-if="result" class="result">
      <h3>Résultat</h3>
      <p>
        {{ result.moved }} traité(s) · {{ result.skipped }} déjà en place ·
        {{ result.createdFolders.length }} dossier(s) créé(s)
      </p>
      <ul v-if="result.createdFolders.length" class="created-list">
        <li v-for="f in result.createdFolders" :key="f">
          <span class="folder">{{ f }}</span>
        </li>
      </ul>
      <ul v-if="result.errors.length" class="errors">
        <li v-for="(err, i) in result.errors" :key="i">{{ err }}</li>
      </ul>
    </div>

    <div v-if="emptyDirs.length" class="cleanup">
      <h3>Répertoires vides détectés ({{ emptyDirs.length }})</h3>
      <p>Souhaitez-vous les supprimer ? (souvent des dossiers sources vidés après déplacement)</p>
      <ul class="created-list">
        <li v-for="dir in emptyDirs" :key="dir">
          <span class="folder">{{ dir }}</span>
        </li>
      </ul>
      <div class="cleanup-actions">
        <button type="button" class="btn primary" :disabled="cleaning" @click="confirmRemoveEmpty">
          {{ cleaning ? 'Suppression…' : 'Supprimer les répertoires vides' }}
        </button>
        <button type="button" class="btn" :disabled="cleaning" @click="skipRemoveEmpty">
          Conserver
        </button>
      </div>
    </div>

    <p v-if="emptyCleanupDone && emptyCleanupMessage" class="ok">{{ emptyCleanupMessage }}</p>
  </section>
</template>

<style scoped>
.organizer {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

header h2 {
  margin: 0 0 0.35rem;
  font-size: 1.25rem;
}

header p {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
}

code {
  font-size: 0.85em;
  padding: 0.1em 0.35em;
  background: var(--surface);
  border-radius: 4px;
}

.options {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
}

.field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  color: var(--muted);
}

.field select {
  font: inherit;
  color: var(--text);
  padding: 0.4rem 0.55rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
}

.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
}

.preview,
.result,
.cleanup {
  padding: 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.cleanup {
  border-color: #e0b84a;
  background: #fffbf0;
}

.preview h3,
.result h3,
.cleanup h3 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}

.cleanup p {
  margin: 0 0 0.75rem;
  color: var(--muted);
  font-size: 0.9rem;
}

.cleanup-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.tree,
.tree-nested,
.created-list,
.errors {
  margin: 0;
  padding: 0;
  list-style: none;
}

.tree-nested {
  margin-left: 1rem;
  padding-left: 0.75rem;
  border-left: 1px solid var(--border);
  margin-top: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.tree {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.tree-row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: baseline;
  padding: 0.25rem 0.35rem;
  border-radius: 6px;
}

.tree-year > .tree-row {
  font-weight: 700;
}

.tree-month > .tree-row {
  font-weight: 600;
}

.tree-day > .tree-row {
  font-weight: 500;
}

.folder {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9rem;
}

.count {
  color: var(--muted);
  font-size: 0.85rem;
  white-space: nowrap;
}

.created-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.5rem;
}

.error {
  color: var(--danger);
  margin: 0;
  white-space: pre-wrap;
}

.errors {
  margin-top: 0.75rem;
  color: var(--danger);
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.empty {
  margin: 0;
  color: var(--muted);
}

.ok {
  margin: 0;
  color: var(--accent);
}
</style>
