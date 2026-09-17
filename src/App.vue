<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AnalysisReportPanel from './components/AnalysisReport.vue'
import HierarchyTree from './components/HierarchyTree.vue'
import DuplicateFinder from './components/DuplicateFinder.vue'
import DateOrganizer from './components/DateOrganizer.vue'
import { analyzeDirectory, isDirectoryPickerSupported } from './services/scanner'
import { filterActiveFiles, toggleExcludedPath } from './services/exclusions'
import type { AnalysisReport, AppTab } from './types/files'

const supported = isDirectoryPickerSupported()
const rootHandle = ref<FileSystemDirectoryHandle | null>(null)
const report = ref<AnalysisReport | null>(null)
const scanning = ref(false)
const scannedCount = ref(0)
const error = ref('')
const tab = ref<AppTab>('analyse')
const excludedPaths = ref<string[]>([])

const tabs = computed(() => [
  { id: 'analyse' as const, label: 'Analyse' },
  { id: 'hierarchie' as const, label: 'Hiérarchie' },
  { id: 'doublons' as const, label: 'Doublons' },
  { id: 'organiser' as const, label: 'Organiser' },
])

const activeFiles = computed(() =>
  report.value ? filterActiveFiles(report.value.files, excludedPaths.value) : [],
)

const excludedFileCount = computed(() =>
  report.value ? report.value.files.length - activeFiles.value.length : 0,
)

watch(report, () => {
  excludedPaths.value = []
})

async function pickAndScan() {
  error.value = ''
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
    rootHandle.value = handle
    await runScan(handle)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function runScan(handle: FileSystemDirectoryHandle) {
  scanning.value = true
  scannedCount.value = 0
  report.value = null
  try {
    report.value = await analyzeDirectory(handle, (count) => {
      scannedCount.value = count
    })
    tab.value = 'analyse'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanning.value = false
  }
}

async function refreshAfterOrganize() {
  if (rootHandle.value) {
    await runScan(rootHandle.value)
  }
}

function onToggleExclude(path: string) {
  excludedPaths.value = toggleExcludedPath(excludedPaths.value, path)
}

function clearExclusions() {
  excludedPaths.value = []
}
</script>

<template>
  <div class="app">
    <header class="top">
      <div class="brand">
        <p class="eyebrow">Photo Manager</p>
        <h1>Organisez vos photos &amp; vidéos</h1>
        <p class="lead">
          Analysez un répertoire, visualisez la hiérarchie, détectez les doublons et rangez par année/mois.
        </p>
      </div>
      <div class="actions">
        <button
          v-if="supported"
          type="button"
          class="btn primary"
          :disabled="scanning"
          @click="pickAndScan"
        >
          {{ scanning ? `Scan… ${scannedCount} fichiers` : report ? 'Changer de dossier' : 'Choisir un dossier' }}
        </button>
        <button
          v-if="rootHandle && !scanning"
          type="button"
          class="btn"
          @click="runScan(rootHandle)"
        >
          Rescanner
        </button>
      </div>
    </header>

    <p v-if="!supported" class="banner warn">
      L’API File System Access n’est pas disponible. Utilisez Chrome, Edge ou un navigateur Chromium récent.
    </p>
    <p v-if="error" class="banner error">{{ error }}</p>
    <p v-if="report && excludedPaths.length" class="banner warn">
      {{ excludedPaths.length }} dossier(s) exclu(s) · {{ excludedFileCount }} fichier(s) ignoré(s)
      par Doublons et Organiser.
      <button type="button" class="linkish" @click="clearExclusions">Tout réintégrer</button>
    </p>

    <nav v-if="report" class="tabs" aria-label="Sections">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        class="tab"
        :class="{ active: tab === t.id }"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
    </nav>

    <main v-if="report" class="panel">
      <AnalysisReportPanel v-show="tab === 'analyse'" :report="report" />

      <section v-show="tab === 'hierarchie'" class="hierarchy">
        <h2>Organigramme des dossiers</h2>
        <p class="hint">
          Compteurs par répertoire. Utilisez <strong>Exclure</strong> pour ignorer un dossier (et
          ses sous-dossiers) dans Doublons et Organiser.
        </p>
        <HierarchyTree
          :node="report.tree"
          :excluded-paths="excludedPaths"
          @toggle-exclude="onToggleExclude"
        />
      </section>

      <DuplicateFinder
        v-show="tab === 'doublons'"
        :files="activeFiles"
        :root-handle="rootHandle"
        @deleted="refreshAfterOrganize"
      />

      <DateOrganizer
        v-show="tab === 'organiser'"
        :files="activeFiles"
        :root-handle="rootHandle"
        @organized="refreshAfterOrganize"
      />
    </main>

    <section v-else-if="!scanning" class="empty-state">
      <p>Sélectionnez un dossier local pour démarrer l’analyse récursive.</p>
    </section>
  </div>
</template>

<style scoped>
.linkish {
  appearance: none;
  border: none;
  background: none;
  color: var(--accent);
  font: inherit;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;
  margin-left: 0.5rem;
  padding: 0;
}
</style>
