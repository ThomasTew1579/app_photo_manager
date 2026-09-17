<script setup lang="ts">
import { computed } from 'vue'
import type { AnalysisReport } from '../types/files'
import { formatSize, formatDate } from '../services/scanner'

const props = defineProps<{
  report: AnalysisReport
}>()

const stats = computed(() => [
  { label: 'Fichiers', value: String(props.report.totalFiles) },
  { label: 'Images', value: String(props.report.totalImages) },
  { label: 'Vidéos', value: String(props.report.totalVideos) },
  { label: 'Autres', value: String(props.report.totalOthers) },
  { label: 'Dossiers', value: String(props.report.directoryCount) },
  { label: 'Taille', value: formatSize(props.report.totalSize) },
])
</script>

<template>
  <section class="report">
    <header class="report-header">
      <h2>Rapport d’analyse</h2>
      <p>
        Racine <strong>{{ report.rootName }}</strong>
        · scanné le {{ formatDate(report.scannedAt.getTime()) }}
      </p>
    </header>
    <div class="stats">
      <div v-for="stat in stats" :key="stat.label" class="stat">
        <span class="stat-value">{{ stat.value }}</span>
        <span class="stat-label">{{ stat.label }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.report {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.report-header h2 {
  margin: 0 0 0.35rem;
  font-size: 1.25rem;
}

.report-header p {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 0.75rem;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.9rem 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.stat-value {
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.stat-label {
  font-size: 0.8rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
