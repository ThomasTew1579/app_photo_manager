# Photo Manager

Application web **Vue 3 + Vite + TypeScript** pour analyser, dépiler les doublons et organiser des photos/vidéos **locales** (navigateur, sans serveur).

> Chrome ou Edge recommandés — l’app s’appuie sur l’[API File System Access](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API).

## Démarrage local

```bash
npm install
npm run dev
```

Puis ouvrir l’URL affichée par Vite (souvent `http://localhost:5173`).

Autres commandes :

| Commande | Rôle |
|---|---|
| `npm run build` | Build production dans `dist/` |
| `npm run preview` | Prévisualiser le build |
| `npm run deploy` | Build + publication sur **GitHub Pages** |

## Fonctionnalités

- Analyse récursive d’un dossier ou périphérique
- Bibliothèque style Photos (séparateurs de dates, scroll)
- Rapport d’analyse + hiérarchie avec compteurs
- Détection de doublons (average hash / aHash), résultats progressifs, arrêt possible
- Organisation année → mois → jour, formats de noms configurables
- Préservation des dates d’origine via EXIF JPEG + `_photo_meta.json`
- Nettoyage des dossiers vides après organisation

## Documentation du projet

Ces fichiers sont **versionnés** avec le dépôt :

| Fichier | Contenu |
|---|---|
| [`prompt.txt`](./prompt.txt) | Historique des consignes + rapports d’implémentation |
| [`PROMPT_CREATION.txt`](./PROMPT_CREATION.txt) | Prompt de recréation / spécification de l’application |

## Publication sur GitHub Pages

1. Créer le dépôt GitHub et ajouter le remote :

```bash
git remote add origin https://github.com/<USER>/<REPO>.git
git push -u origin main
```

2. Installer les dépendances (inclut `gh-pages`) puis déployer :

```bash
npm install
npm run deploy
```

Cela construit l’app et pousse le contenu de `dist/` sur la branche `gh-pages`.

3. Sur GitHub : **Settings → Pages → Build and deployment → Source** = branche `gh-pages` / dossier `/ (root)`.

L’app sera disponible sur :

`https://<USER>.github.io/<REPO>/`

Le `base: './'` dans `vite.config.ts` permet de servir l’app sous ce sous-chemin sans configuration supplémentaire.

## Stack

- Vue 3 + TypeScript
- Vite 8
- heic2any (aperçu HEIC)
- File System Access API (lecture / écriture locale)
