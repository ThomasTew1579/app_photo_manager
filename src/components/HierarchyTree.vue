<script setup lang="ts">
import { computed } from 'vue'
import type { DirectoryNode } from '../types/files'
import { formatSize, isEmptyDirectory } from '../services/scanner'

const props = defineProps<{
  node: DirectoryNode
  depth?: number
  excludedPaths: string[]
  /** Empêche de supprimer la racine. */
  isRoot?: boolean
}>()

const emit = defineEmits<{
  toggleExclude: [path: string]
  deleteEmpty: [relativePath: string]
}>()

const depth = computed(() => props.depth ?? 0)
const empty = computed(() => isEmptyDirectory(props.node))

const isExcluded = computed(() => props.excludedPaths.includes(props.node.path))

const isExcludedByParent = computed(() =>
  props.excludedPaths.some(
    (ex) => ex !== props.node.path && (props.node.path === ex || props.node.path.startsWith(`${ex}/`)),
  ),
)

const effectivelyExcluded = computed(() => isExcluded.value || isExcludedByParent.value)

function onToggle() {
  if (isExcludedByParent.value) return
  emit('toggleExclude', props.node.path)
}

function onDeleteEmpty() {
  if (!empty.value || props.isRoot || !props.node.relativePath) return
  if (
    !confirm(
      `Supprimer le dossier vide « ${props.node.name} » et ses sous-dossiers vides ?`,
    )
  ) {
    return
  }
  emit('deleteEmpty', props.node.relativePath)
}
</script>

<template>
  <div
    class="tree-node"
    :class="{ excluded: effectivelyExcluded, empty }"
    :style="{ '--depth': depth }"
  >
    <div class="tree-row">
      <span class="tree-icon" aria-hidden="true">{{ empty ? '📂' : '📁' }}</span>
      <span class="tree-name">{{ node.name }}</span>
      <span v-if="empty" class="tag-empty">Vide</span>
      <span class="tree-meta">
        {{ node.fileCount }} fichier{{ node.fileCount > 1 ? 's' : '' }}
        · {{ node.imageCount }} img
        · {{ node.videoCount }} vid
        · {{ formatSize(node.totalSize) }}
      </span>
      <button
        v-if="empty && !isRoot && node.relativePath"
        type="button"
        class="btn-delete-empty"
        title="Supprimer ce dossier vide"
        @click="onDeleteEmpty"
      >
        Supprimer
      </button>
      <button
        type="button"
        class="btn-exclude"
        :class="{ active: isExcluded, locked: isExcludedByParent }"
        :disabled="isExcludedByParent"
        :title="
          isExcludedByParent
            ? 'Exclu via un dossier parent'
            : isExcluded
              ? 'Réintégrer ce dossier dans les autres outils'
              : 'Exclure ce dossier des autres outils'
        "
        @click="onToggle"
      >
        {{ isExcludedByParent ? 'Exclu (parent)' : isExcluded ? 'Exclu' : 'Exclure' }}
      </button>
    </div>
    <div v-if="node.children.length" class="tree-children">
      <HierarchyTree
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :excluded-paths="excludedPaths"
        @toggle-exclude="emit('toggleExclude', $event)"
        @delete-empty="emit('deleteEmpty', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-node {
  margin-left: calc(var(--depth) * 1.1rem);
}

.tree-node.excluded > .tree-row {
  opacity: 0.55;
}

.tree-node.excluded > .tree-row .tree-name {
  text-decoration: line-through;
}

.tree-node.empty > .tree-row {
  background: var(--empty-folder-bg);
  border: 1px solid var(--empty-folder-border);
}

.tree-node.empty > .tree-row:hover {
  background: #4a3c18;
}

.tree-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  padding: 0.4rem 0.55rem;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.tree-row:hover {
  background: var(--surface-hover);
}

.tree-icon {
  font-size: 0.95rem;
}

.tree-name {
  font-weight: 600;
  color: var(--text);
}

.tag-empty {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--warning-text);
  background: #5c4a1a;
  border-radius: 999px;
  padding: 0.15rem 0.45rem;
}

.tree-meta {
  font-size: 0.8rem;
  color: var(--muted);
  flex: 1;
}

.btn-exclude,
.btn-delete-empty {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  border-radius: 999px;
  padding: 0.2rem 0.65rem;
  font: inherit;
  font-size: 0.72rem;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}

.btn-exclude:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}

.btn-exclude.active {
  background: #5c1f1c;
  border-color: var(--danger);
  color: #ff8a80;
}

.btn-exclude.locked,
.btn-exclude:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-delete-empty {
  border-color: var(--warning-border);
  color: var(--warning-text);
  background: var(--warning-bg);
}

.btn-delete-empty:hover {
  border-color: var(--danger);
  color: var(--danger);
  background: #fff0ee;
}

.tree-children {
  border-left: 1px solid var(--border);
  margin-left: 0.65rem;
  padding-left: 0.25rem;
}
</style>
