import { exec, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Remonte l'arborescence depuis `startDir` pour trouver le dépôt git le plus proche. */
export function findGitRoot(startDir: string): string {
    let current = path.resolve(startDir);
    while (true) {
        if (fs.existsSync(path.join(current, '.git'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return startDir;
        }
        current = parent;
    }
}

/**
 * Retourne tous les dépôts git du workspace.
 * Utilise l'API git de VS Code en priorité (elle détecte déjà tout),
 * avec un fallback sur un scan récursif de l'arborescence.
 */
function findAllGitRoots(workspaceRoot: string): string[] {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    const gitApi = gitExt?.exports?.getAPI?.(1);
    if (gitApi?.repositories?.length > 0) {
        const allRoots: string[] = gitApi.repositories.map(
            (r: { rootUri: vscode.Uri }) => r.rootUri.fsPath,
        );
        // Only keep repos that overlap with the current workspace
        const sep = path.sep;
        const relevant = allRoots.filter(
            root =>
                root === workspaceRoot ||
                root.startsWith(workspaceRoot + sep) ||
                workspaceRoot.startsWith(root + sep),
        );
        if (relevant.length > 0) {
            return relevant;
        }
    }

    // Fallback: recursive scan
    return scanForGitRoots(workspaceRoot);
}

const EXCLUDED_DIRS = new Set([
    '.git', 'node_modules', 'vendor', 'dist', 'build', '.next',
    '__pycache__', '.tox', 'coverage', '.cache',
]);

function scanForGitRoots(dir: string, depth = 0): string[] {
    if (depth > 6) {
        return [];
    }

    const roots: string[] = [];

    if (fs.existsSync(path.join(dir, '.git'))) {
        roots.push(dir);
    }

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) {
                continue;
            }
            roots.push(...scanForGitRoots(path.join(dir, entry.name), depth + 1));
        }
    } catch {
        // permission error ou autre — ignorer
    }

    return roots;
}

export function getModifiedFiles(
    workspaceRoot: string,
    source: 'working_diff' | 'last_commit',
): Array<{ filePath: string; gitStatus: 'M' | 'A' | 'D' }> {
    const allFiles = new Map<string, 'M' | 'A' | 'D'>();
    const gitRoots = findAllGitRoots(workspaceRoot);

    for (const gitRoot of gitRoots) {
        try {
            let filesInRepo: string[];

            if (source === 'last_commit') {
                const out = execSync('git diff --name-only HEAD~1 HEAD', { cwd: gitRoot }).toString();
                for (const f of out.split('\n').filter(Boolean)) {
                    const rel = path.relative(workspaceRoot, path.join(gitRoot, f));
                    if (!rel.startsWith('..')) {
                        allFiles.set(rel, 'M');
                    }
                }
            } else {
                const out = execSync('git status --porcelain', { cwd: gitRoot }).toString();
                for (const line of out.split('\n').filter(Boolean)) {
                    const xy = line.substring(0, 2);
                    if (xy === 'DD') {
                        continue;
                    }
                    const rawName = line.slice(3);
                    const name = rawName.indexOf(' -> ') >= 0
                        ? rawName.slice(rawName.indexOf(' -> ') + 4)
                        : rawName;
                    if (name.endsWith('/')) {
                        continue;
                    }
                    const rel = path.relative(workspaceRoot, path.join(gitRoot, name));
                    if (rel.startsWith('..')) {
                        continue;
                    }
                    const gitStatus: 'M' | 'A' | 'D' =
                        xy === 'D ' || xy === ' D' ? 'D'
                        : xy === '??' || xy === 'A ' || xy === ' A' ? 'A'
                        : 'M';
                    allFiles.set(rel, gitStatus);
                }
            }
        } catch {
            // repo sans commits ou erreur git — ignorer
        }
    }

    return Array.from(allFiles.entries()).map(([filePath, gitStatus]) => ({ filePath, gitStatus }));
}

export async function discardFile(workspaceRoot: string, filePath: string): Promise<void> {
    const absolute = path.resolve(workspaceRoot, filePath);
    const gitRoot = findGitRoot(path.dirname(absolute));
    const relToGit = path.relative(gitRoot, absolute);
    return new Promise(resolve => {
        exec(`git restore -- "${relToGit}"`, { cwd: gitRoot }, (err) => {
            if (!err) {
                resolve();
                return;
            }
            // Untracked file — delete it
            try {
                if (fs.existsSync(absolute)) {
                    fs.unlinkSync(absolute);
                }
            } catch { /* ignore */ }
            resolve();
        });
    });
}

export function getOriginalContent(workspaceRoot: string, filePath: string): Promise<string> {
    return new Promise(resolve => {
        try {
            const absolute = path.resolve(workspaceRoot, filePath);
            const gitRoot = findGitRoot(path.dirname(absolute));
            const relToGit = path.relative(gitRoot, absolute);
            exec(`git show HEAD:"${relToGit}"`, { cwd: gitRoot }, (err, stdout) => {
                resolve(err ? '' : stdout);
            });
        } catch {
            resolve('');
        }
    });
}
