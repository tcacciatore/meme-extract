# Meme Extract

Bibliothèque locale de clips vidéo (YouTube et tout site supporté par yt-dlp), découpés,
taggés et lisibles depuis le navigateur.

## Lancer

```bash
./run.sh
```

Puis ouvrir http://127.0.0.1:5050. Le premier lancement crée `.venv/` (Python ≥ 3.10 requis,
yt-dlp ne supporte plus 3.9) et installe `flask` + `yt-dlp`. `ffmpeg` doit être installé.

## Utilisation

**Ajouter un clip**
1. Coller l'URL, « Charger » : titre, durée et lecteur YouTube intégré.
2. Repérer le passage dans le lecteur, puis « ⏱ Position actuelle » pour le début et la fin
   (ou taper `1:23`, `83`, `1:23.5`). Raccourcis : `I` début, `O` fin, `P` prévisualiser,
   `Espace` lecture/pause, `←`/`→` ±1 s, `Maj+←/→` ±0,1 s.
3. Titre + tags (le **premier tag** décide du dossier). « Extraire et télécharger ».

Le clip est téléchargé en arrière-plan, découpé précisément (ré-encodage aux bornes),
et rangé dans `clips/<tag principal>/<titre>_<début>-<fin>_<id>.mp4`. Les autres tags
reçoivent un lien symbolique vers le même fichier dans `clips/<tag>/`.

**Bibliothèque**
- Filtres par tag en trois états : 1 clic = tag **exigé**, 2 clics = tag **exclu**, 3 clics = neutre.
  Plusieurs tags exigés = tous requis (ET).
- Recherche texte (titres, titre source, nom des projets) et tri : récents, anciens,
  plus/moins utilisés, plus courts/longs, titre.
- Lecture sur place, ouvrir dans le Finder, télécharger, modifier titre/tags, supprimer
  (confirmation en deux clics).
- **« Déjà utilisé dans… »** : sur chaque clip, indiquer la vidéo/projet où il a servi ;
  compteur d'utilisations, liste datée, tri « jamais utilisés » pour éviter les redites.
- **Exports dérivés** : boutons MP3, WAV (audio seul) et GIF, générés par ffmpeg à côté du mp4.
- **Export vertical 9:16** (Shorts, TikTok, Reels) pour un clip ou une compilation : « fond flou »
  (vidéo entière centrée sur son propre fond flouté) ou « recadrage plein cadre » avec curseur de
  position et aperçu. Sortie 1080×1920 en `<nom>_9x16.mp4`, générée en arrière-plan.
- **« 📤 TikTok »** sur la version 9:16 : feuille de partage système avec le fichier (iPhone, iPad,
  Safari — TikTok apparaît dans la liste) ; sur ordinateur, copie le titre, affiche le fichier dans
  le Finder et ouvre TikTok Studio (upload) pour un glisser-déposer. La publication automatique via
  l'API TikTok n'est pas intégrée (elle exige une app développeur TikTok validée).
- **Gérer les tags** : créer des tags à l'avance, supprimer ceux qui sont vides.

**Compilations (lecture à la suite / assemblage)**
- « ＋ Compil » sur une carte (ou « Tout sélectionner ») ajoute le clip à une sélection
  ordonnable, affichée dans la barre en bas (mémorisée entre deux visites).
- « ▶ Lire à la suite » enchaîne les clips dans un lecteur plein écran (←/→, boucle, Échap).
- « 🔀 Mélanger » réordonne la sélection au hasard ; la case « Ordre aléatoire » (cochée par
  défaut) mélange les clips au moment de la compilation.
- « 🎲 Compiler les N clips affichés (aléatoire) » dans la section Compilations prend les clips
  du filtre courant (tags, exclusions, recherche) et lance directement une compilation.
- « ☑ Sélectionner les clips affichés » remplace la sélection ; « ＋ Ajouter les clips affichés »
  la complète (pour combiner plusieurs filtres).
- « 🎬 Compiler en une vidéo » assemble la sélection avec ffmpeg en un seul mp4
  (1080p, 30 fps, stéréo — les clips hétérogènes sont mis à l'échelle et pillarboxés),
  rangé dans `clips/_compilations/`. La section « Compilations » liste, lit et télécharge.

**Partager sa bibliothèque**
- « Exporter (JSON léger) » : liens, bornes et tags seulement. La personne qui l'importe
  re-télécharge chaque clip depuis YouTube.
- « Exporter avec les vidéos (ZIP) » : même chose + fichiers mp4, importés sans téléchargement.
- « Importer un export… » accepte les deux formats ; les doublons (même vidéo, mêmes bornes
  à 0,5 s près) sont ignorés.

## API (résumé)

| Méthode | Route | Rôle |
|---|---|---|
| `POST` | `/api/info` | infos d'une URL |
| `GET/POST` | `/api/clips` | liste (`tags`, `exclude`, `q`, `status`, `sort`, `order`) / création |
| `GET/PUT/DELETE` | `/api/clips/<id>` | détail / titre+tags / suppression |
| `POST` | `/api/clips/<id>/retry`, `/reveal`, `/export` | relancer, Finder, dérivé `{format: mp3|wav|gif}` |
| `POST` | `/api/clips/<id>/vertical` · `/api/compilations/<id>/vertical` | export 9:16 `{mode: blur|crop, position: 0..1}` |
| `POST` | `/api/clips/<id>/usages` · `DELETE /api/usages/<id>` | utilisations |
| `GET` | `/api/projects` | projets connus |
| `GET/POST/DELETE` | `/api/tags[/<name>]` | tags |
| `GET/POST` | `/api/compilations` · `GET/DELETE /api/compilations/<id>` | compilations (`{clip_ids, title, shuffle}`) |
| `GET` | `/api/export[?files=1]` · `POST /api/import` | partage |
| `GET` | `/media/<chemin>` | fichiers |

## Configuration (variables d'environnement)

| Variable     | Défaut      | Rôle                                   |
|--------------|-------------|----------------------------------------|
| `PORT`       | `5050`      | Port HTTP                              |
| `CLIPS_DIR`  | `./clips`   | Dossier des vidéos                     |
| `DB_PATH`    | `./memes.db`| Base SQLite (métadonnées + tags)       |
| `MAX_HEIGHT` | `1080`      | Résolution max téléchargée             |

## En cas d'erreur YouTube (« Sign in to confirm you're not a bot », etc.)

Mettre yt-dlp à jour : `.venv/bin/pip install -U yt-dlp`.
