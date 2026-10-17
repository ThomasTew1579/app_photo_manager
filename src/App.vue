<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AnalysisReportPanel from './components/AnalysisReport.vue'
import HierarchyTree from './components/HierarchyTree.vue'
import DuplicateFinder from './components/DuplicateFinder.vue'
import DateOrganizer from './components/DateOrganizer.vue'
import PhotoLibrary from './components/PhotoLibrary.vue'
import { analyzeDirectory, countDirectories, isDirectoryPickerSupported, removeDirectoryByRelativePath } from './services/scanner'
import { filterActiveFiles, toggleExcludedPath } from './services/exclusions'
import { DuplicateScanAbortedError, findDuplicateImages } from './services/duplicates'
import { removeEmptyDirectories } from './services/organizer'
import type { AnalysisReport, AppTab, DuplicateGroup, SourceKind } from './types/files'

const supported = isDirectoryPickerSupported()
const rootHandle = ref<FileSystemDirectoryHandle | null>(null)
const sourceKind = ref<SourceKind | null>(null)
const report = ref<AnalysisReport | null>(null)
const scanning = ref(false)
const scannedCount = ref(0)
const error = ref('')
const tab = ref<AppTab>('bibliotheque')
const excludedPaths = ref<string[]>([])
const sidebarCollapsed = ref(false)

const dupBackgroundLoading = ref(false)
const dupBackgroundProgress = ref({ done: 0, total: 0 })
const dupBackgroundGroups = ref<DuplicateGroup[] | null>(null)
let dupScanToken = 0
let dupAbort: AbortController | null = null

const navItems = computed(() => [
  { id: 'bibliotheque' as const, label: 'Bibliothèque', group: 'Médias' },
  { id: 'analyse' as const, label: 'Analyse', group: 'Outils' },
  { id: 'hierarchie' as const, label: 'Hiérarchie', group: 'Outils' },
  { id: 'doublons' as const, label: 'Doublons', group: 'Outils' },
  { id: 'organiser' as const, label: 'Organiser', group: 'Outils' },
])

const mediaNav = computed(() => navItems.value.filter((i) => i.group === 'Médias'))
const toolNav = computed(() => navItems.value.filter((i) => i.group === 'Outils'))

const activeFiles = computed(() =>
  report.value ? filterActiveFiles(report.value.files, excludedPaths.value) : [],
)

const excludedFileCount = computed(() =>
  report.value ? report.value.files.length - activeFiles.value.length : 0,
)

const sourceLabel = computed(() => {
  if (!report.value) return 'Photos'
  const kind = sourceKind.value === 'device' ? 'Périphérique' : 'Dossier'
  return `${kind} · ${report.value.rootName}`
})

const dupNavBadge = computed(() => {
  if (dupBackgroundLoading.value) return '…'
  if (dupBackgroundGroups.value) return String(dupBackgroundGroups.value.length)
  return ''
})

watch(report, () => {
  excludedPaths.value = []
})

watch(activeFiles, (files) => {
  if (report.value && files.length) {
    void startBackgroundDuplicates(files)
  }
})

async function startBackgroundDuplicates(files: typeof activeFiles.value) {
  dupAbort?.abort()
  const token = ++dupScanToken
  const ac = new AbortController()
  dupAbort = ac
  dupBackgroundLoading.value = true
  dupBackgroundGroups.value = null
  dupBackgroundProgress.value = { done: 0, total: 0 }
  try {
    const groups = await findDuplicateImages(files, {
      threshold: 2,
      partialEvery: 40,
      concurrency: 4,
      signal: ac.signal,
      persistRoot: rootHandle.value ?? undefined,
      onProgress: (done, total) => {
        if (token !== dupScanToken) return
        dupBackgroundProgress.value = { done, total }
      },
      onPartial: (partial) => {
        if (token !== dupScanToken) return
        dupBackgroundGroups.value = partial
      },
    })
    if (token !== dupScanToken) return
    dupBackgroundGroups.value = groups
  } catch (e) {
    if (token !== dupScanToken) return
    if (e instanceof DuplicateScanAbortedError) {
      dupBackgroundGroups.value = e.groups
    } else {
      dupBackgroundGroups.value = dupBackgroundGroups.value ?? []
    }
  } finally {
    if (token === dupScanToken) {
      dupBackgroundLoading.value = false
      if (dupAbort === ac) dupAbort = null
    }
  }
}

function stopDuplicateScan() {
  dupAbort?.abort()
  dupAbort = null
  dupScanToken++
  dupBackgroundLoading.value = false
}

async function pickSource(kind: SourceKind) {
  error.value = ''
  try {
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite',
      // Pour un périphérique, l’utilisateur sélectionne la racine du volume (ex. /Volumes/…)
      id: kind === 'device' ? 'photo-manager-device' : 'photo-manager-folder',
    })
    sourceKind.value = kind
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
  stopDuplicateScan()
  dupBackgroundGroups.value = null
  try {
    report.value = await analyzeDirectory(handle, (count) => {
      scannedCount.value = count
    })
    tab.value = 'bibliotheque'
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

async function onDeleteEmpty(relativePath: string) {
  if (!rootHandle.value || !report.value) return
  error.value = ''
  try {
    const res = await removeEmptyDirectories(rootHandle.value, [relativePath])
    if (res.errors.length) {
      error.value = res.errors.join('\n')
      return
    }
    // Mise à jour locale de l’arbre — pas de réimport complet
    const nextTree = removeDirectoryByRelativePath(report.value.tree, relativePath)
    const rootName = report.value.rootName
    const fullPath = relativePath ? `${rootName}/${relativePath}` : rootName
    report.value = {
      ...report.value,
      tree: nextTree,
      directoryCount: countDirectories(nextTree),
    }
    excludedPaths.value = excludedPaths.value.filter(
      (p) => p !== fullPath && !p.startsWith(`${fullPath}/`),
    )
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function disconnect() {
  stopDuplicateScan()
  rootHandle.value = null
  report.value = null
  sourceKind.value = null
  excludedPaths.value = []
  dupBackgroundGroups.value = null
  tab.value = 'bibliotheque'
}
</script>

<template>
  <div class="photos-shell" :class="{ collapsed: sidebarCollapsed }">
    <aside class="sidebar" aria-label="Navigation">
      <div class="sidebar-brand">
        <span class="app-icon" aria-hidden="true">◉</span>
        <strong>Photos</strong>
      </div>

      <template v-if="report">
        <p class="nav-label">Bibliothèque</p>
        <nav class="nav">
          <button
            v-for="item in mediaNav"
            :key="item.id"
            type="button"
            class="nav-item"
            :class="{ active: tab === item.id }"
            @click="tab = item.id"
          >
            {{ item.label }}
          </button>
        </nav>

        <p class="nav-label">Outils</p>
        <nav class="nav">
          <button
            v-for="item in toolNav"
            :key="item.id"
            type="button"
            class="nav-item"
            :class="{ active: tab === item.id }"
            @click="tab = item.id"
          >
            {{ item.label }}
            <span v-if="item.id === 'doublons' && dupNavBadge" class="nav-badge">{{
              dupNavBadge
            }}</span>
          </button>
        </nav>

        <div class="sidebar-footer">
          <p class="source-chip">{{ sourceLabel }}</p>
          <button
            v-if="rootHandle && !scanning"
            type="button"
            class="btn small"
            @click="runScan(rootHandle)"
          >
            Actualiser
          </button>
          <button type="button" class="btn small ghost" @click="disconnect">Changer de source</button>
        </div>
      </template>

      <p v-else class="sidebar-hint">Importez un périphérique ou un dossier pour commencer.</p>
    </aside>

    <div class="main">
      <header class="topbar">
        <button
          type="button"
          class="btn ghost sidebar-toggle"
          :aria-expanded="!sidebarCollapsed"
          @click="sidebarCollapsed = !sidebarCollapsed"
        >
          ☰
        </button>
        <div class="topbar-title">
          <span v-if="scanning">Importation… {{ scannedCount }} fichiers</span>
          <span v-else-if="report">{{ navItems.find((i) => i.id === tab)?.label }}</span>
          <span v-else>Bienvenue</span>
        </div>
      </header>

      <div class="content">
        <p v-if="!supported" class="banner warn">
          L’API File System Access n’est pas disponible. Utilisez Chrome, Edge ou un navigateur
          Chromium récent (macOS / Windows).
        </p>
        <p v-if="error" class="banner error">{{ error }}</p>
        <p v-if="report && excludedPaths.length" class="banner warn">
          {{ excludedPaths.length }} dossier(s) exclu(s) · {{ excludedFileCount }} fichier(s)
          ignoré(s) par Doublons et Organiser.
          <button type="button" class="linkish" @click="clearExclusions">Tout réintégrer</button>
        </p>

        <!-- Écran d’accueil façon Photos -->
        <section v-if="!report && !scanning" class="welcome">
          <div class="welcome-hero">
            <p class="welcome-kicker">Photos</p>
            <h1>Votre bibliothèque, sur cet appareil</h1>
            <p class="welcome-lead">
              Sélectionnez un périphérique entier (carte SD, appareil photo, volume externe) ou un
              dossier précis, puis parcourez, triez et organisez comme dans l’app Photos.
            </p>
            <div class="welcome-actions" v-if="supported">
              <button type="button" class="btn primary welcome-btn" @click="pickSource('device')">
                Importer un périphérique
              </button>
              <button type="button" class="btn welcome-btn" @click="pickSource('folder')">
                Choisir un dossier
              </button>
            </div>
            <p class="welcome-note">
              Astuce périphérique : choisissez la racine du volume (souvent le nom de la carte ou
              « DCIM » parent) dans la boîte de dialogue.
            </p>
          </div>
        </section>

        <div v-else-if="scanning" class="loading-state">
          <div class="spinner" aria-hidden="true" />
          <p>Analyse de {{ scannedCount }} fichier{{ scannedCount > 1 ? 's' : '' }}…</p>
        </div>

        <template v-else-if="report">
          <nav class="mobile-nav" aria-label="Onglets">
            <button
              v-for="item in navItems"
              :key="item.id"
              type="button"
              class="mobile-nav-item"
              :class="{ active: tab === item.id }"
              @click="tab = item.id"
            >
              {{ item.label }}
            </button>
          </nav>

          <PhotoLibrary
            v-show="tab === 'bibliotheque'"
            :files="activeFiles"
            :source-label="sourceLabel"
          />

          <div v-show="tab === 'analyse'" class="tool-panel">
            <AnalysisReportPanel :report="report" />
          </div>

          <section v-show="tab === 'hierarchie'" class="tool-panel hierarchy">
            <h2>Hiérarchie</h2>
            <p class="hint">
              Les dossiers <strong>vides</strong> sont surlignés. Utilisez
              <strong>Supprimer</strong> ou <strong>Exclure</strong> selon le besoin.
            </p>
            <HierarchyTree
              :node="report.tree"
              :excluded-paths="excludedPaths"
              is-root
              @toggle-exclude="onToggleExclude"
              @delete-empty="onDeleteEmpty"
            />
          </section>

          <div v-show="tab === 'doublons'" class="tool-panel">
            <DuplicateFinder
              :files="activeFiles"
              :root-handle="rootHandle"
              :background-groups="dupBackgroundGroups"
              :background-loading="dupBackgroundLoading"
              :background-progress="dupBackgroundProgress"
              @deleted="refreshAfterOrganize"
              @stop="stopDuplicateScan"
            />
          </div>

          <div v-show="tab === 'organiser'" class="tool-panel">
            <DateOrganizer
              :files="activeFiles"
              :root-handle="rootHandle"
              @organized="refreshAfterOrganize"
            />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.photos-shell {
  display: grid;
  grid-template-columns: 240px 1fr;
  height: 100%;
  min-height: 100vh;
  background: var(--bg);
}

.photos-shell.collapsed {
  grid-template-columns: 0 1fr;
}

.photos-shell.collapsed .sidebar {
  overflow: hidden;
  border: none;
  padding: 0;
  opacity: 0;
  pointer-events: none;
}

.sidebar {
  background: var(--sidebar);
  border-right: 1px solid var(--border);
  padding: 1rem 0.75rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  transition: opacity 0.2s ease;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.35rem 0.65rem 1rem;
  font-size: 1.05rem;
  letter-spacing: -0.02em;
}

.app-icon {
  color: var(--accent);
  font-size: 1.1rem;
}

.nav-label {
  margin: 0.85rem 0.65rem 0.25rem;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  appearance: none;
  border: none;
  background: transparent;
  text-align: left;
  font: inherit;
  font-size: 0.92rem;
  font-weight: 500;
  color: var(--text);
  padding: 0.45rem 0.7rem;
  border-radius: 8px;
  cursor: pointer;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.nav-item.active {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}

.nav-badge {
  margin-left: 0.35rem;
  font-size: 0.7rem;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.25);
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
}

.nav-item:not(.active) .nav-badge {
  background: var(--fill-secondary);
  color: var(--muted);
}

.sidebar-footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.75rem 0.35rem 0;
}

.source-chip {
  margin: 0;
  font-size: 0.75rem;
  color: var(--muted);
  padding: 0 0.35rem;
  word-break: break-word;
}

.sidebar-hint {
  margin: 0.5rem 0.65rem;
  color: var(--muted);
  font-size: 0.85rem;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 100vh;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--topbar-bg);
  backdrop-filter: blur(16px);
  position: sticky;
  top: 0;
  z-index: 5;
}

.topbar-title {
  font-weight: 600;
  font-size: 0.95rem;
}

.content {
  flex: 1;
  padding: 1.25rem 1.5rem 2rem;
  overflow: auto;
}

.welcome {
  min-height: calc(100vh - 5rem);
  display: grid;
  place-items: center;
  background:
    radial-gradient(ellipse 70% 55% at 50% 0%, rgba(10, 132, 255, 0.18), transparent 60%),
    var(--bg);
}

.welcome-hero {
  max-width: 36rem;
  text-align: center;
  padding: 2rem 1rem;
}

.welcome-kicker {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
}

.welcome-hero h1 {
  margin: 0.5rem 0 0.75rem;
  font-size: clamp(2rem, 4vw, 2.75rem);
  letter-spacing: -0.04em;
  font-weight: 700;
  line-height: 1.1;
}

.welcome-lead {
  margin: 0 auto 1.5rem;
  color: var(--muted);
  font-size: 1.05rem;
  max-width: 30rem;
}

.welcome-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  justify-content: center;
}

.welcome-btn {
  min-width: 12rem;
  padding: 0.75rem 1.25rem;
}

.welcome-note {
  margin: 1.25rem 0 0;
  font-size: 0.8rem;
  color: var(--muted);
}

.loading-state {
  min-height: 50vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  color: var(--muted);
}

.spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 3px solid var(--fill-secondary);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.tool-panel {
  max-width: 980px;
}

.linkish {
  appearance: none;
  border: none;
  background: none;
  color: var(--accent);
  font: inherit;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
  margin-left: 0.35rem;
  padding: 0;
}

@media (max-width: 800px) {
  .photos-shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    display: none;
  }

  .photos-shell.collapsed .sidebar {
    display: none;
  }

  .mobile-nav {
    display: flex;
  }
}

.mobile-nav {
  display: none;
  gap: 0.35rem;
  overflow-x: auto;
  padding-bottom: 0.75rem;
  margin-bottom: 0.5rem;
}

.mobile-nav-item {
  appearance: none;
  border: none;
  background: var(--fill-secondary);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0.45rem 0.75rem;
  border-radius: 980px;
  white-space: nowrap;
  cursor: pointer;
}

.mobile-nav-item.active {
  background: var(--accent);
  color: #fff;
}
</style>
