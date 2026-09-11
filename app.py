"""
Meme Extract — bibliothèque locale de clips vidéo (YouTube & co).

- POST /api/info        : infos d'une URL (titre, durée, id, miniature)
- POST /api/clips       : crée un clip (url, start, end, tags) et lance l'extraction
- GET  /api/clips       : liste (filtre ?tag= et ?q=)
- GET  /api/clips/<id>  : détail + statut
- PUT  /api/clips/<id>  : modifie titre / tags
- DELETE /api/clips/<id>: supprime le clip et ses fichiers
- POST /api/clips/<id>/reveal : ouvre le fichier dans le Finder
- GET  /api/tags        : tags avec nombre de clips
- GET  /media/<chemin>  : sert les fichiers vidéo
"""
import glob
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import unicodedata
import zipfile
from datetime import datetime
from pathlib import Path
from typing import List, Optional

import yt_dlp
from flask import Flask, abort, after_this_request, jsonify, request, send_file, send_from_directory
from yt_dlp.utils import download_range_func

BASE_DIR = Path(__file__).resolve().parent
CLIPS_DIR = Path(os.environ.get("CLIPS_DIR", BASE_DIR / "clips")).resolve()
DB_PATH = Path(os.environ.get("DB_PATH", BASE_DIR / "memes.db"))
MAX_HEIGHT = int(os.environ.get("MAX_HEIGHT", "1080"))

CLIPS_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["JSON_AS_ASCII"] = False

DEFAULT_TAGS = ["drôle", "triste", "choc", "wtf", "cringe", "victoire", "échec", "colère", "mignon", "suspense"]

# Progression des téléchargements en cours (clip_id -> message)
PROGRESS = {}
PROGRESS_LOCK = threading.Lock()


# --------------------------------------------------------------------------- DB

def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS clips (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                title        TEXT NOT NULL,
                source_url   TEXT NOT NULL,
                source_title TEXT,
                video_id     TEXT,
                thumbnail    TEXT,
                start        REAL NOT NULL,
                "end"        REAL NOT NULL,
                path         TEXT,
                status       TEXT NOT NULL DEFAULT 'pending',
                error        TEXT,
                created_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tags (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS usages (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
                project TEXT NOT NULL,
                used_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS clip_tags (
                clip_id  INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
                tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (clip_id, tag_id)
            );
            """
        )
        conn.executemany("INSERT OR IGNORE INTO tags(name) VALUES (?)", [(t,) for t in DEFAULT_TAGS])
        # Un redémarrage pendant un téléchargement laisse des clips bloqués : on les marque en erreur.
        conn.execute(
            "UPDATE clips SET status='error', error='Interrompu (serveur redémarré)' "
            "WHERE status IN ('pending','downloading')"
        )


# ---------------------------------------------------------------------- helpers

def slugify(text: str, max_len: int = 60) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:max_len].strip("-") or "clip"


def normalize_tag(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip().lower())


def tag_dirname(name: str) -> str:
    return slugify(name, 40)


def parse_time(value) -> float:
    """Accepte 83, '83', '1:23', '1:23.5', '0:01:23'."""
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(",", ".")
    if not s:
        raise ValueError("temps vide")
    parts = s.split(":")
    if len(parts) > 3:
        raise ValueError("format de temps invalide")
    total = 0.0
    for p in parts:
        total = total * 60 + float(p)
    return total


def fmt_time_file(seconds: float) -> str:
    seconds = int(round(seconds))
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m{s:02d}s" if h else f"{m}m{s:02d}s"


def clip_to_dict(conn, row) -> dict:
    tags = [
        r["name"]
        for r in conn.execute(
            "SELECT t.name FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id "
            "WHERE ct.clip_id = ? ORDER BY ct.position",
            (row["id"],),
        )
    ]
    usages = [
        {"id": u["id"], "project": u["project"], "used_at": u["used_at"]}
        for u in conn.execute(
            "SELECT id, project, used_at FROM usages WHERE clip_id = ? ORDER BY used_at DESC, id DESC",
            (row["id"],),
        )
    ]
    with PROGRESS_LOCK:
        progress = PROGRESS.get(row["id"])
    return {
        "id": row["id"],
        "title": row["title"],
        "source_url": row["source_url"],
        "source_title": row["source_title"],
        "video_id": row["video_id"],
        "thumbnail": row["thumbnail"],
        "start": row["start"],
        "end": row["end"],
        "duration": round(row["end"] - row["start"], 2),
        "path": row["path"],
        "media_url": f"/media/{row['path']}" if row["path"] else None,
        "status": row["status"],
        "error": row["error"],
        "progress": progress,
        "tags": tags,
        "usages": usages,
        "use_count": len(usages),
        "exports": existing_exports(row["path"]),
        "created_at": row["created_at"],
    }


def set_clip_tags(conn, clip_id: int, tags: List[str]):
    conn.execute("DELETE FROM clip_tags WHERE clip_id = ?", (clip_id,))
    for pos, name in enumerate(tags):
        conn.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (name,))
        tag_id = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()["id"]
        conn.execute(
            "INSERT OR IGNORE INTO clip_tags(clip_id, tag_id, position) VALUES (?,?,?)",
            (clip_id, tag_id, pos),
        )


def clean_tags(raw) -> List[str]:
    if isinstance(raw, str):
        raw = raw.split(",")
    seen, out = set(), []
    for t in raw or []:
        n = normalize_tag(str(t))
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

# Formats dérivés générés à la demande à côté du mp4 (même nom, autre extension)
EXPORT_FORMATS = {
    "mp3": ["-vn", "-c:a", "libmp3lame", "-q:a", "2"],
    "wav": ["-vn", "-c:a", "pcm_s16le"],
    "gif": ["-vf", "fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0"],
}


def derivative_path(rel_path: str, fmt: str) -> Path:
    return (CLIPS_DIR / rel_path).with_suffix("." + fmt)


def existing_exports(rel_path: Optional[str]) -> dict:
    if not rel_path:
        return {}
    out = {}
    for fmt in EXPORT_FORMATS:
        p = derivative_path(rel_path, fmt)
        if p.exists():
            out[fmt] = f"/media/{p.relative_to(CLIPS_DIR).as_posix()}"
    return out


def make_export(rel_path: str, fmt: str) -> Path:
    src = CLIPS_DIR / rel_path
    dst = derivative_path(rel_path, fmt)
    if dst.exists():
        return dst
    tmp = dst.with_name(dst.stem + ".tmp" + dst.suffix)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src)] + EXPORT_FORMATS[fmt] + [str(tmp)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(proc.stderr.strip()[-300:] or "ffmpeg a échoué")
    tmp.rename(dst)
    return dst


def set_progress(clip_id: int, message: Optional[str]):
    if message is not None:
        message = ANSI_RE.sub("", message)
    with PROGRESS_LOCK:
        if message is None:
            PROGRESS.pop(clip_id, None)
        else:
            PROGRESS[clip_id] = message


# ---------------------------------------------------------------- yt-dlp / ffmpeg

def fetch_info(url: str) -> dict:
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") == "playlist" and info.get("entries"):
        info = info["entries"][0]
    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "extractor": info.get("extractor_key"),
        "webpage_url": info.get("webpage_url") or url,
        "is_youtube": (info.get("extractor_key") or "").lower().startswith("youtube"),
    }


def remove_clip_files(rel_path: Optional[str]):
    """Supprime le fichier principal et tous les liens symboliques qui pointent dessus."""
    if not rel_path:
        return
    main = CLIPS_DIR / rel_path
    name = main.name
    for link in CLIPS_DIR.glob(f"*/{name}"):
        if link.is_symlink():
            link.unlink()
    if main.exists():
        main.unlink()
    for fmt in EXPORT_FORMATS:
        derivative_path(rel_path, fmt).unlink(missing_ok=True)


def run_download(clip_id: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
        if not row:
            return
        clip = clip_to_dict(conn, row)
        conn.execute("UPDATE clips SET status='downloading' WHERE id = ?", (clip_id,))

    tags = clip["tags"] or ["non-classé"]
    primary_dir = CLIPS_DIR / tag_dirname(tags[0])
    primary_dir.mkdir(parents=True, exist_ok=True)

    base_name = "{}_{}-{}_{}".format(
        slugify(clip["title"]),
        fmt_time_file(clip["start"]),
        fmt_time_file(clip["end"]),
        clip["video_id"] or clip_id,
    )
    # Nettoie d'éventuels restes d'une tentative précédente
    for old in glob.glob(str(primary_dir / (base_name + ".*"))):
        os.remove(old)

    def hook(d):
        if d.get("status") == "downloading":
            pct = d.get("_percent_str", "").strip()
            set_progress(clip_id, f"Téléchargement {pct}".strip())
        elif d.get("status") == "finished":
            set_progress(clip_id, "Découpage / encodage…")

    def pp_hook(d):
        if d.get("status") == "started":
            set_progress(clip_id, f"Post-traitement ({d.get('postprocessor')})…")

    opts = {
        "format": (
            f"bestvideo[ext=mp4][height<={MAX_HEIGHT}]+bestaudio[ext=m4a]"
            f"/bestvideo[height<={MAX_HEIGHT}]+bestaudio/best[ext=mp4]/best"
        ),
        "merge_output_format": "mp4",
        "outtmpl": str(primary_dir / (base_name + ".%(ext)s")),
        "download_ranges": download_range_func(None, [(clip["start"], clip["end"])]),
        "force_keyframes_at_cuts": True,  # coupe précise (ré-encodage aux bornes)
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "overwrites": True,
        "progress_hooks": [hook],
        "postprocessor_hooks": [pp_hook],
        "postprocessors": [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}],
    }

    set_progress(clip_id, "Préparation…")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(clip["source_url"], download=True)

        final = None
        for rd in info.get("requested_downloads") or []:
            fp = rd.get("filepath")
            if fp and os.path.exists(fp):
                final = Path(fp)
                break
        if final is None:
            candidates = sorted(glob.glob(str(primary_dir / (base_name + ".*"))), key=os.path.getmtime)
            if not candidates:
                raise RuntimeError("fichier de sortie introuvable après téléchargement")
            final = Path(candidates[-1])

        # Un lien symbolique dans le dossier de chaque tag secondaire
        for extra in tags[1:]:
            d = CLIPS_DIR / tag_dirname(extra)
            d.mkdir(parents=True, exist_ok=True)
            link = d / final.name
            if not link.exists() and not link.is_symlink():
                os.symlink(os.path.relpath(final, d), link)

        rel = final.relative_to(CLIPS_DIR).as_posix()
        with db() as conn:
            conn.execute(
                "UPDATE clips SET status='done', path=?, error=NULL WHERE id = ?", (rel, clip_id)
            )
    except Exception as exc:  # noqa: BLE001
        msg = ANSI_RE.sub("", str(exc)).replace("ERROR: ", "")[:500]
        with db() as conn:
            conn.execute("UPDATE clips SET status='error', error=? WHERE id = ?", (msg, clip_id))
    finally:
        set_progress(clip_id, None)


# ------------------------------------------------------------------------ routes

@app.after_request
def no_cache(resp):
    # Appli locale : on évite que le navigateur garde une vieille version du JS/CSS
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/media/<path:rel>")
def media(rel):
    target = (CLIPS_DIR / rel).resolve()
    if CLIPS_DIR not in target.parents or not target.is_file():
        abort(404)
    return send_from_directory(CLIPS_DIR, rel, conditional=True)


@app.post("/api/info")
def api_info():
    url = (request.get_json(silent=True) or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "URL manquante"}), 400
    try:
        return jsonify(fetch_info(url))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)[:500]}), 400


@app.get("/api/tags")
def api_tags():
    with db() as conn:
        rows = conn.execute(
            """
            SELECT t.name, COUNT(ct.clip_id) AS count,
                   SUM(CASE WHEN c.status = 'done' THEN 1 ELSE 0 END) AS done
            FROM tags t
            LEFT JOIN clip_tags ct ON ct.tag_id = t.id
            LEFT JOIN clips c ON c.id = ct.clip_id
            GROUP BY t.id ORDER BY count DESC, t.name
            """
        ).fetchall()
    return jsonify([{"name": r["name"], "count": r["count"], "done": r["done"] or 0} for r in rows])


@app.post("/api/tags")
def api_create_tag():
    tags = clean_tags((request.get_json(silent=True) or {}).get("names") or (request.get_json(silent=True) or {}).get("name"))
    if not tags:
        return jsonify({"error": "Nom de tag vide"}), 400
    with db() as conn:
        conn.executemany("INSERT OR IGNORE INTO tags(name) VALUES (?)", [(t,) for t in tags])
    return jsonify({"ok": True, "tags": tags}), 201


@app.delete("/api/tags/<name>")
def api_delete_tag(name):
    name = normalize_tag(name)
    with db() as conn:
        used = conn.execute(
            "SELECT COUNT(*) FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.name = ?",
            (name,),
        ).fetchone()[0]
        if used:
            return jsonify({"error": "Ce tag est encore utilisé par des clips"}), 400
        conn.execute("DELETE FROM tags WHERE name = ?", (name,))
    return jsonify({"ok": True})


SORTS = {
    "date": "c.created_at {o}, c.id {o}",
    "duration": '(c."end" - c.start) {o}, c.id DESC',
    "uses": "(SELECT COUNT(*) FROM usages u WHERE u.clip_id = c.id) {o}, c.created_at DESC",
    "title": "lower(c.title) {o}",
}

TAG_MATCH = "EXISTS (SELECT 1 FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.clip_id = c.id AND t.name = ?)"


@app.get("/api/clips")
def api_clips():
    # Filtres : tags=a,b (tous requis), exclude=c,d (aucun toléré), q=texte, status=, sort=date|duration|uses|title, order=asc|desc
    include = clean_tags(request.args.get("tags", "") + "," + request.args.get("tag", ""))
    exclude = clean_tags(request.args.get("exclude", ""))
    q = request.args.get("q", "").strip().lower()
    status = request.args.get("status", "").strip()
    sort = request.args.get("sort", "date")
    order = "ASC" if request.args.get("order", "desc").lower() == "asc" else "DESC"
    sql = "SELECT c.* FROM clips c"
    params: list = []
    where = []
    for t in include:
        where.append(TAG_MATCH)
        params.append(t)
    for t in exclude:
        where.append("NOT " + TAG_MATCH)
        params.append(t)
    if q:
        where.append("(lower(c.title) LIKE ? OR lower(c.source_title) LIKE ? OR EXISTS (SELECT 1 FROM usages u WHERE u.clip_id = c.id AND lower(u.project) LIKE ?))")
        params += [f"%{q}%", f"%{q}%", f"%{q}%"]
    if status:
        where.append("c.status = ?")
        params.append(status)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY " + SORTS.get(sort, SORTS["date"]).format(o=order)
    with db() as conn:
        rows = conn.execute(sql, params).fetchall()
        return jsonify([clip_to_dict(conn, r) for r in rows])


@app.post("/api/clips")
def api_create_clip():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "URL manquante"}), 400
    try:
        start = parse_time(data.get("start", 0))
        end = parse_time(data.get("end"))
    except (ValueError, TypeError):
        return jsonify({"error": "Début/fin invalides (ex : 1:23 ou 83)"}), 400
    if end <= start:
        return jsonify({"error": "La fin doit être après le début"}), 400
    tags = clean_tags(data.get("tags"))
    if not tags:
        return jsonify({"error": "Ajoute au moins un tag"}), 400

    info = data.get("info") or {}
    if not info.get("id"):
        try:
            info = fetch_info(url)
        except Exception as exc:  # noqa: BLE001
            return jsonify({"error": f"Impossible de lire la vidéo : {str(exc)[:300]}"}), 400
    title = (data.get("title") or info.get("title") or "clip").strip()

    with db() as conn:
        cur = conn.execute(
            'INSERT INTO clips(title, source_url, source_title, video_id, thumbnail, start, "end", status, created_at)'
            " VALUES (?,?,?,?,?,?,?,'pending',?)",
            (
                title,
                info.get("webpage_url") or url,
                info.get("title"),
                info.get("id"),
                info.get("thumbnail"),
                start,
                end,
                datetime.now().isoformat(timespec="seconds"),
            ),
        )
        clip_id = cur.lastrowid
        set_clip_tags(conn, clip_id, tags)
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
        result = clip_to_dict(conn, row)

    threading.Thread(target=run_download, args=(clip_id,), daemon=True).start()
    return jsonify(result), 201


@app.get("/api/clips/<int:clip_id>")
def api_get_clip(clip_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
        if not row:
            abort(404)
        return jsonify(clip_to_dict(conn, row))


@app.put("/api/clips/<int:clip_id>")
def api_update_clip(clip_id):
    data = request.get_json(silent=True) or {}
    with db() as conn:
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
        if not row:
            abort(404)
        if "title" in data and data["title"].strip():
            conn.execute("UPDATE clips SET title = ? WHERE id = ?", (data["title"].strip(), clip_id))
        if "tags" in data:
            tags = clean_tags(data["tags"])
            if not tags:
                return jsonify({"error": "Un clip doit garder au moins un tag"}), 400
            set_clip_tags(conn, clip_id, tags)
            # Met à jour les liens symboliques dans les dossiers de tags
            if row["path"]:
                main = CLIPS_DIR / row["path"]
                for link in CLIPS_DIR.glob(f"*/{main.name}"):
                    if link.is_symlink():
                        link.unlink()
                for extra in tags:
                    d = CLIPS_DIR / tag_dirname(extra)
                    if d == main.parent:
                        continue
                    d.mkdir(parents=True, exist_ok=True)
                    link = d / main.name
                    if not link.exists() and not link.is_symlink():
                        os.symlink(os.path.relpath(main, d), link)
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
        return jsonify(clip_to_dict(conn, row))


@app.post("/api/clips/<int:clip_id>/retry")
def api_retry_clip(clip_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
        if not row:
            abort(404)
        if row["status"] in ("pending", "downloading"):
            return jsonify({"error": "Déjà en cours"}), 400
        conn.execute("UPDATE clips SET status='pending', error=NULL WHERE id = ?", (clip_id,))
    threading.Thread(target=run_download, args=(clip_id,), daemon=True).start()
    return jsonify({"ok": True})


@app.delete("/api/clips/<int:clip_id>")
def api_delete_clip(clip_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
        if not row:
            abort(404)
        remove_clip_files(row["path"])
        conn.execute("DELETE FROM clips WHERE id = ?", (clip_id,))
    return jsonify({"ok": True})


# ---- utilisations ("déjà utilisé dans…")

@app.get("/api/projects")
def api_projects():
    with db() as conn:
        rows = conn.execute(
            "SELECT project, COUNT(*) AS n, MAX(used_at) AS last FROM usages GROUP BY project ORDER BY last DESC"
        ).fetchall()
    return jsonify([{"project": r["project"], "count": r["n"], "last": r["last"]} for r in rows])


@app.post("/api/clips/<int:clip_id>/usages")
def api_add_usage(clip_id):
    project = re.sub(r"\s+", " ", (request.get_json(silent=True) or {}).get("project", "")).strip()
    if not project:
        return jsonify({"error": "Indique le nom de la vidéo / du projet"}), 400
    with db() as conn:
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
        if not row:
            abort(404)
        conn.execute(
            "INSERT INTO usages(clip_id, project, used_at) VALUES (?,?,?)",
            (clip_id, project, datetime.now().isoformat(timespec="seconds")),
        )
        return jsonify(clip_to_dict(conn, row)), 201


@app.delete("/api/usages/<int:usage_id>")
def api_delete_usage(usage_id):
    with db() as conn:
        row = conn.execute("SELECT clip_id FROM usages WHERE id = ?", (usage_id,)).fetchone()
        if not row:
            abort(404)
        conn.execute("DELETE FROM usages WHERE id = ?", (usage_id,))
        clip = conn.execute("SELECT * FROM clips WHERE id = ?", (row["clip_id"],)).fetchone()
        return jsonify(clip_to_dict(conn, clip))


# ---- exports dérivés (mp3 / wav / gif)

@app.post("/api/clips/<int:clip_id>/export")
def api_export_clip(clip_id):
    fmt = (request.get_json(silent=True) or {}).get("format", "")
    if fmt not in EXPORT_FORMATS:
        return jsonify({"error": f"Format inconnu (choix : {', '.join(EXPORT_FORMATS)})"}), 400
    with db() as conn:
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
    if not row or not row["path"] or row["status"] != "done":
        return jsonify({"error": "Le clip n'est pas encore prêt"}), 400
    try:
        make_export(row["path"], fmt)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 500
    with db() as conn:
        return jsonify(clip_to_dict(conn, row))


# ---- partage : export / import de la bibliothèque

EXPORT_VERSION = 1


def library_manifest(conn, with_files: bool) -> dict:
    clips = []
    for row in conn.execute("SELECT * FROM clips WHERE status = 'done' ORDER BY id"):
        c = clip_to_dict(conn, row)
        clips.append({
            "title": c["title"],
            "source_url": c["source_url"],
            "source_title": c["source_title"],
            "video_id": c["video_id"],
            "thumbnail": c["thumbnail"],
            "start": c["start"],
            "end": c["end"],
            "tags": c["tags"],
            "file": ("videos/" + c["path"]) if with_files and c["path"] else None,
            "created_at": c["created_at"],
        })
    return {
        "app": "meme-extract",
        "version": EXPORT_VERSION,
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "clips": clips,
    }


@app.get("/api/export")
def api_export_library():
    with_files = request.args.get("files", "0") in ("1", "true", "yes")
    stamp = datetime.now().strftime("%Y-%m-%d")
    with db() as conn:
        manifest = library_manifest(conn, with_files)
    if not with_files:
        buf = io.BytesIO(json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
        return send_file(buf, mimetype="application/json", as_attachment=True, download_name=f"memes-{stamp}.json")

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_STORED) as zf:  # les mp4 sont déjà compressés
        zf.writestr("memes.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        for c in manifest["clips"]:
            if c["file"]:
                zf.write(CLIPS_DIR / c["file"][len("videos/"):], c["file"])

    @after_this_request
    def cleanup(resp):
        try:
            os.remove(tmp.name)
        except OSError:
            pass
        return resp

    return send_file(tmp.name, mimetype="application/zip", as_attachment=True, download_name=f"memes-{stamp}.zip")


def clip_exists(conn, video_id: Optional[str], source_url: str, start: float, end: float) -> bool:
    """Doublon = même vidéo (id ou URL) et bornes à moins de 0,5 s."""
    rows = conn.execute(
        "SELECT start, \"end\" FROM clips WHERE (video_id = ? AND video_id IS NOT NULL) OR source_url = ?",
        (video_id, source_url),
    ).fetchall()
    return any(abs(r["start"] - start) < 0.5 and abs(r["end"] - end) < 0.5 for r in rows)


@app.post("/api/import")
def api_import_library():
    up = request.files.get("file")
    if not up:
        return jsonify({"error": "Aucun fichier reçu"}), 400
    data = up.read()
    zf = None
    try:
        if zipfile.is_zipfile(io.BytesIO(data)):
            zf = zipfile.ZipFile(io.BytesIO(data))
            manifest = json.loads(zf.read("memes.json").decode("utf-8"))
        else:
            manifest = json.loads(data.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Fichier illisible : {str(exc)[:200]}"}), 400
    if manifest.get("app") != "meme-extract" or not isinstance(manifest.get("clips"), list):
        return jsonify({"error": "Ce n'est pas un export Meme Extract"}), 400

    imported, skipped, downloading, errors = 0, 0, 0, []
    to_download = []
    with db() as conn:
        for c in manifest["clips"]:
            try:
                url = (c.get("source_url") or "").strip()
                start, end = float(c["start"]), float(c["end"])
                tags = clean_tags(c.get("tags")) or ["importé"]
                if not url or end <= start:
                    raise ValueError("URL ou bornes invalides")
                if clip_exists(conn, c.get("video_id"), url, start, end):
                    skipped += 1
                    continue
                cur = conn.execute(
                    'INSERT INTO clips(title, source_url, source_title, video_id, thumbnail, start, "end", status, created_at)'
                    " VALUES (?,?,?,?,?,?,?,'pending',?)",
                    (
                        (c.get("title") or c.get("source_title") or "clip").strip(),
                        url, c.get("source_title"), c.get("video_id"), c.get("thumbnail"),
                        start, end, datetime.now().isoformat(timespec="seconds"),
                    ),
                )
                clip_id = cur.lastrowid
                set_clip_tags(conn, clip_id, tags)

                member = c.get("file")
                if zf is not None and member and member in zf.namelist():
                    # Vidéo fournie dans le zip : on la copie au lieu de la re-télécharger
                    primary_dir = CLIPS_DIR / tag_dirname(tags[0])
                    primary_dir.mkdir(parents=True, exist_ok=True)
                    dest = primary_dir / Path(member).name
                    with zf.open(member) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out)
                    for extra in tags[1:]:
                        d = CLIPS_DIR / tag_dirname(extra)
                        d.mkdir(parents=True, exist_ok=True)
                        link = d / dest.name
                        if not link.exists() and not link.is_symlink():
                            os.symlink(os.path.relpath(dest, d), link)
                    conn.execute(
                        "UPDATE clips SET status='done', path=? WHERE id = ?",
                        (dest.relative_to(CLIPS_DIR).as_posix(), clip_id),
                    )
                else:
                    to_download.append(clip_id)
                    downloading += 1
                imported += 1
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{c.get('title', '?')} : {str(exc)[:120]}")

    for clip_id in to_download:
        threading.Thread(target=run_download, args=(clip_id,), daemon=True).start()
    return jsonify({"imported": imported, "skipped": skipped, "downloading": downloading, "errors": errors})


@app.post("/api/clips/<int:clip_id>/reveal")
def api_reveal_clip(clip_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
    if not row or not row["path"]:
        abort(404)
    subprocess.Popen(["open", "-R", str(CLIPS_DIR / row["path"])])
    return jsonify({"ok": True})


init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    print(f"Meme Extract → http://127.0.0.1:{port}   (clips : {CLIPS_DIR})")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
