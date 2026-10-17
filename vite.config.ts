import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// base relatif : fonctionne en local et sur GitHub Pages (sous-chemin du dépôt)
export default defineConfig({
  plugins: [vue()],
  base: './',
})
