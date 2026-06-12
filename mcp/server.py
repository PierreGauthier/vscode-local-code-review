import json
import os
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("code-review")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _ws(workspace: Optional[str]) -> Path:
    return Path(workspace) if workspace else Path(os.getcwd())


_EXCLUDED_DIRS = {
    ".git", "node_modules", "vendor", "dist", "build", ".next",
    "__pycache__", ".tox", "coverage", ".cache",
}


def _find_git_root(start: Path) -> Path:
    current = start.resolve()
    while current != current.parent:
        if (current / ".git").exists():
            return current
        current = current.parent
    return start


def _scan_git_roots(directory: Path, depth: int = 0) -> list[Path]:
    if depth > 6:
        return []
    roots: list[Path] = []
    if (directory / ".git").exists():
        roots.append(directory)
    try:
        for entry in directory.iterdir():
            if entry.is_dir() and entry.name not in _EXCLUDED_DIRS:
                roots.extend(_scan_git_roots(entry, depth + 1))
    except PermissionError:
        pass
    return roots


def _all_git_roots(workspace: Optional[str]) -> list[Path]:
    return _scan_git_roots(_ws(workspace))


def _git_root_for(file_path: str, workspace: Optional[str]) -> Path:
    absolute = (_ws(workspace) / file_path).resolve()
    return _find_git_root(absolute.parent)


def _review_file(workspace: Optional[str]) -> Path:
    return _ws(workspace) / ".vscode" / "code-review.json"


def _read_state(workspace: Optional[str]) -> dict:
    p = _review_file(workspace)
    if not p.exists():
        raise ValueError(
            f"Aucune review en cours dans `{_ws(workspace)}`. "
            "Lancer 'Init Review' dans VS Code d'abord."
        )
    return json.loads(p.read_text(encoding="utf-8"))


def _write_state(state: dict, workspace: Optional[str]) -> None:
    p = _review_file(workspace)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


# ---------------------------------------------------------------------------
# MCP tools
# ---------------------------------------------------------------------------


@mcp.tool()
def get_review_summary(workspace: Optional[str] = None) -> str:
    """Vue globale de la review en cours : mode, fichiers restants, commentaires ouverts.

    workspace : chemin absolu du projet (défaut : répertoire courant).
    """
    state = _read_state(workspace)
    files = state.get("files", {})

    total = len(files)
    validated = sum(1 for f in files.values() if f["status"] == "validated")
    orphaned = sum(1 for f in files.values() if f.get("orphaned"))

    lines = [
        f"# Code Review",
        f"Workspace : `{_ws(workspace)}`",
        f"Source : `{state['source']}` — started {state['startedAt'][:10]}",
        "",
        f"**Fichiers :** {validated}/{total} validés"
        + (f" ({orphaned} hors diff)" if orphaned else ""),
        "",
    ]

    for path, f in files.items():
        open_count = sum(
            1 for c in f.get("comments", []) if c["status"] == "open" and not c.get("parent_id")
        )
        if f.get("orphaned"):
            icon, suffix = "🔘", " [hors diff]"
        elif f["status"] == "validated":
            icon, suffix = "✅", ""
        elif open_count > 0:
            icon, suffix = "🔴", f" — {open_count} commentaire(s) ouvert(s)"
        else:
            icon, suffix = "🟡", " — à reviewer"
        lines.append(f"{icon} `{path}`{suffix}")

    return "\n".join(lines)


@mcp.tool()
def list_files(status_filter: Optional[str] = None, workspace: Optional[str] = None) -> str:
    """Liste les fichiers de la review avec leur statut et le nombre de commentaires ouverts.

    status_filter : 'to_review', 'validated', ou None pour tous.
    workspace     : chemin absolu du projet (défaut : répertoire courant).
    """
    state = _read_state(workspace)
    files = state.get("files", {})

    if status_filter:
        files = {k: v for k, v in files.items() if v["status"] == status_filter}

    if not files:
        suffix = f" avec statut '{status_filter}'" if status_filter else ""
        return f"Aucun fichier{suffix}."

    lines = []
    for path, f in files.items():
        open_count = sum(1 for c in f.get("comments", []) if c["status"] == "open")
        orphan = " [hors diff]" if f.get("orphaned") else ""
        lines.append(f"[{f['status']}]{orphan} {path} — {open_count} commentaire(s) ouvert(s)")

    return "\n".join(lines)


@mcp.tool()
def get_file_diff(file_path: str, workspace: Optional[str] = None) -> str:
    """Retourne le diff git complet (staged + unstaged) d'un fichier pour pouvoir le reviewer.

    workspace : chemin absolu du projet (défaut : répertoire courant).
    """
    git_root = _git_root_for(file_path, workspace)
    abs_path = (_ws(workspace) / file_path).resolve()
    rel_to_git = abs_path.relative_to(git_root)

    result = subprocess.run(
        ["git", "diff", "HEAD", "--", str(rel_to_git)],
        cwd=git_root,
        capture_output=True,
        text=True,
    )
    diff = result.stdout

    if not diff:
        result = subprocess.run(
            ["git", "diff", "--cached", "--", str(rel_to_git)],
            cwd=git_root,
            capture_output=True,
            text=True,
        )
        diff = result.stdout

    if not diff:
        return f"Aucun diff trouvé pour `{file_path}`."

    return diff


@mcp.tool()
def get_file_comments(
    file_path: str,
    status_filter: Optional[str] = None,
    author_filter: Optional[str] = None,
    workspace: Optional[str] = None,
) -> str:
    """Retourne les commentaires d'un fichier organisés en threads.

    status_filter : 'open' ou 'resolved'.
    author_filter : 'human' ou 'claude'.
    workspace     : chemin absolu du projet (défaut : répertoire courant).
    """
    state = _read_state(workspace)
    file_data = state.get("files", {}).get(file_path)
    if not file_data:
        return f"Fichier '{file_path}' introuvable dans la review."

    comments = file_data.get("comments", [])
    if status_filter:
        comments = [c for c in comments if c["status"] == status_filter]
    if author_filter:
        comments = [c for c in comments if c["author"] == author_filter]

    if not comments:
        parts = []
        if status_filter:
            parts.append(status_filter)
        if author_filter:
            parts.append(f"de {author_filter}")
        suffix = " " + " ".join(parts) if parts else ""
        return f"Aucun commentaire{suffix} sur `{file_path}`."

    all_comments = file_data.get("comments", [])
    roots = [c for c in comments if not c.get("parent_id")]

    lines = [f"# Commentaires — {file_path}\n"]
    for c in roots:
        line_info = f"ligne {c['line']}" if c.get("line") else "général"
        lines.append(
            f"**[{c['id'][:8]}]** [{c['author']}] [{c['status']}] {line_info} — {c['createdAt'][:10]}"
        )
        lines.append(c["content"])
        for r in all_comments:
            if r.get("parent_id") == c["id"]:
                lines.append(
                    f"  ↳ **[{r['id'][:8]}]** [{r['author']}] [{r['status']}] {r['createdAt'][:10]}"
                )
                lines.append(f"  {r['content']}")
        lines.append("")

    return "\n".join(lines)


@mcp.tool()
def add_comment(
    file_path: str,
    content: str,
    line: Optional[int] = None,
    parent_id: Optional[str] = None,
    workspace: Optional[str] = None,
) -> str:
    """Ajoute un commentaire de review sur un fichier. L'auteur est toujours 'claude'.

    file_path : chemin relatif du fichier (ex: 'src/foo.ts').
    content   : texte du commentaire.
    line      : numéro de ligne concernée dans le diff (optionnel).
    parent_id : 8 premiers caractères de l'ID du commentaire parent pour répondre à un thread.
    workspace : chemin absolu du projet (défaut : répertoire courant).
    """
    state = _read_state(workspace)
    files = state.get("files", {})

    if file_path not in files:
        available = ", ".join(files.keys()) or "aucun"
        return f"Fichier '{file_path}' introuvable. Fichiers disponibles : {available}"

    resolved_parent_id = None
    if parent_id:
        all_comments = files[file_path].get("comments", [])
        matches = [c for c in all_comments if c["id"].startswith(parent_id)]
        if not matches:
            return f"Commentaire parent '{parent_id}' introuvable sur {file_path}."
        resolved_parent_id = matches[0]["id"]

    line_content = None
    if line is not None and not resolved_parent_id:
        abs_path = _ws(workspace) / file_path
        try:
            file_lines = abs_path.read_text(encoding="utf-8").splitlines()
            if 0 < line <= len(file_lines):
                line_content = file_lines[line - 1]
        except OSError:
            pass

    comment: dict = {
        "id": str(uuid.uuid4()),
        "content": content,
        "author": "ai",
        "status": "open",
        "createdAt": datetime.utcnow().isoformat(),
    }
    if line is not None:
        comment["line"] = line
    if line_content is not None:
        comment["lineContent"] = line_content
    if resolved_parent_id:
        comment["parent_id"] = resolved_parent_id

    files[file_path].setdefault("comments", []).append(comment)
    _write_state(state, workspace)

    location = f" (ligne {line})" if line else ""
    reply_info = f" en réponse à {parent_id}" if parent_id else ""
    return f"Commentaire ajouté sur `{file_path}`{location}{reply_info} — ID: {comment['id'][:8]}"


@mcp.tool()
def resolve_comment(
    file_path: str,
    comment_id: str,
    workspace: Optional[str] = None,
) -> str:
    """Marque un commentaire claude comme résolu (les 8 premiers caractères de l'ID suffisent).

    Claude ne peut résoudre que ses propres commentaires (author='claude').
    workspace : chemin absolu du projet (défaut : répertoire courant).
    """
    state = _read_state(workspace)
    files = state.get("files", {})

    if file_path not in files:
        return f"Fichier '{file_path}' introuvable dans la review."

    comments = files[file_path].get("comments", [])
    matches = [c for c in comments if c["id"].startswith(comment_id)]

    if not matches:
        return f"Commentaire '{comment_id}' introuvable sur `{file_path}`."

    c = matches[0]
    if c["status"] == "resolved":
        return f"Commentaire '{comment_id}' est déjà résolu."

    c["status"] = "resolved"
    _write_state(state, workspace)
    return f"✅ Commentaire {comment_id} résolu."


@mcp.tool()
def validate_file(file_path: str, workspace: Optional[str] = None) -> str:
    """Valide un fichier (status → 'validated') si tous ses commentaires sont résolus.

    workspace : chemin absolu du projet (défaut : répertoire courant).
    """
    state = _read_state(workspace)
    files = state.get("files", {})
    if file_path not in files:
        return f"Fichier '{file_path}' introuvable dans la review."

    open_comments = [c for c in files[file_path].get("comments", []) if c["status"] == "open"]
    if open_comments:
        details = "\n".join(
            f"  - [{c['id'][:8]}] [{c['author']}] {c['content'][:60]}" for c in open_comments
        )
        return (
            f"❌ Impossible de valider `{file_path}` : "
            f"{len(open_comments)} commentaire(s) ouvert(s) :\n{details}\n"
            "Résolvez-les d'abord avec resolve_comment()."
        )

    files[file_path]["status"] = "validated"
    _write_state(state, workspace)
    return f"✅ `{file_path}` validé."


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
