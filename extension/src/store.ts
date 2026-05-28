import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type ReviewSource = 'working_diff' | 'last_commit';
export type FileStatus = 'to_review' | 'validated';
export type CommentStatus = 'open' | 'resolved';
export type CommentAuthor = 'me' | 'ai';

export interface ReviewComment {
    id: string;
    content: string;
    author: CommentAuthor;
    status: CommentStatus;
    createdAt: string;
    line?: number;
    lineContent?: string;
    parent_id?: string;
}

export type GitStatus = 'M' | 'A' | 'D';

export interface ReviewFile {
    hash: string;
    status: FileStatus;
    gitStatus?: GitStatus;
    comments: ReviewComment[];
}

export interface ReviewState {
    source: ReviewSource;
    startedAt: string;
    files: Record<string, ReviewFile>;
}

function getReviewPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.vscode', 'code-review.json');
}

export function readState(workspaceRoot: string): ReviewState | null {
    const p = getReviewPath(workspaceRoot);
    if (!fs.existsSync(p)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as ReviewState;
    } catch {
        return null;
    }
}

export function writeState(workspaceRoot: string, state: ReviewState): void {
    const p = getReviewPath(workspaceRoot);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
}

export function computeFileHash(absolutePath: string): string {
    try {
        const stat = fs.statSync(absolutePath);
        if (!stat.isFile()) {
            return '';
        }
        const content = fs.readFileSync(absolutePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    } catch {
        return '';
    }
}

export function addComment(
    workspaceRoot: string,
    filePath: string,
    content: string,
    author: CommentAuthor,
    line?: number,
    lineContent?: string,
    parentId?: string,
): ReviewComment | null {
    const state = readState(workspaceRoot);
    if (!state || !state.files[filePath]) {
        return null;
    }

    const comment: ReviewComment = {
        id: crypto.randomUUID(),
        content,
        author,
        status: 'open',
        createdAt: new Date().toISOString(),
    };
    if (line !== undefined) {
        comment.line = line;
    }
    if (lineContent !== undefined) {
        comment.lineContent = lineContent;
    }
    if (parentId) {
        comment.parent_id = parentId;
    }

    state.files[filePath].comments.push(comment);
    writeState(workspaceRoot, state);
    return comment;
}

export function relocateComments(workspaceRoot: string, filePath: string): boolean {
    const state = readState(workspaceRoot);
    if (!state) {
        return false;
    }
    const fileData = state.files[filePath];
    if (!fileData) {
        return false;
    }

    const absolutePath = path.join(workspaceRoot, filePath);
    let fileLines: string[];
    try {
        fileLines = fs.readFileSync(absolutePath, 'utf-8').split('\n');
    } catch {
        return false;
    }

    const SEARCH_WINDOW = 50;
    let changed = false;

    for (const comment of fileData.comments) {
        if (comment.line == null || comment.lineContent == null || comment.parent_id) {
            continue;
        }
        const lineIdx = comment.line - 1;
        if (fileLines[lineIdx]?.trimEnd() === comment.lineContent.trimEnd()) {
            continue;
        }
        const start = Math.max(0, lineIdx - SEARCH_WINDOW);
        const end = Math.min(fileLines.length - 1, lineIdx + SEARCH_WINDOW);
        let bestLine = -1;
        let bestDist = Infinity;
        for (let i = start; i <= end; i++) {
            if (fileLines[i]?.trimEnd() === comment.lineContent.trimEnd()) {
                const dist = Math.abs(i - lineIdx);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestLine = i;
                }
            }
        }
        if (bestLine !== -1) {
            comment.line = bestLine + 1;
            changed = true;
        }
    }

    if (changed) {
        writeState(workspaceRoot, state);
    }
    return changed;
}

export function resolveComment(
    workspaceRoot: string,
    filePath: string,
    commentId: string,
): boolean {
    const state = readState(workspaceRoot);
    if (!state || !state.files[filePath]) {
        return false;
    }

    const comment = state.files[filePath].comments.find(c => c.id === commentId);
    if (!comment || comment.status === 'resolved') {
        return false;
    }

    comment.status = 'resolved';
    writeState(workspaceRoot, state);
    return true;
}

export function devalidateFile(workspaceRoot: string, filePath: string): boolean {
    const state = readState(workspaceRoot);
    if (!state?.files[filePath]) {
        return false;
    }
    state.files[filePath].status = 'to_review';
    writeState(workspaceRoot, state);
    return true;
}

export function resolveThread(
    workspaceRoot: string,
    filePath: string,
    rootLine: number | undefined,
): boolean {
    const state = readState(workspaceRoot);
    if (!state || !state.files[filePath]) {
        return false;
    }

    const comments = state.files[filePath].comments;
    const roots = comments.filter(c => !c.parent_id && c.line === rootLine);
    if (roots.length === 0) {
        return false;
    }

    const rootIds = new Set(roots.map(c => c.id));
    let changed = false;

    for (const c of comments) {
        if (c.status === 'open' && (rootIds.has(c.id) || (c.parent_id && rootIds.has(c.parent_id)))) {
            c.status = 'resolved';
            changed = true;
        }
    }

    if (changed) {
        writeState(workspaceRoot, state);
    }
    return changed;
}

export function validateFile(
    workspaceRoot: string,
    filePath: string,
    force = false,
): { ok: boolean; reason?: string } {
    const state = readState(workspaceRoot);
    if (!state || !state.files[filePath]) {
        return { ok: false, reason: 'File not found.' };
    }

    const openComments = state.files[filePath].comments.filter(c => c.status === 'open');
    if (!force && openComments.length > 0) {
        return { ok: false, reason: `${openComments.length} open comment(s).` };
    }

    state.files[filePath].status = 'validated';
    writeState(workspaceRoot, state);
    return { ok: true };
}

export function refreshHashes(
    workspaceRoot: string,
    currentDiffFiles: Array<{ filePath: string; gitStatus: GitStatus }>,
): boolean {
    const state = readState(workspaceRoot);
    if (!state) {
        return false;
    }

    let changed = false;
    const diffSet = new Map(currentDiffFiles.map(f => [f.filePath, f.gitStatus]));

    // Remove files that are no longer in the diff
    for (const filePath of Object.keys(state.files)) {
        if (!diffSet.has(filePath)) {
            delete state.files[filePath];
            changed = true;
        }
    }

    // Add new files and detect modifications
    for (const { filePath, gitStatus } of currentDiffFiles) {
        const absolutePath = path.join(workspaceRoot, filePath);
        const newHash = computeFileHash(absolutePath);

        if (!state.files[filePath]) {
            state.files[filePath] = { hash: newHash, status: 'to_review', gitStatus, comments: [] };
            changed = true;
        } else {
            if (state.files[filePath].gitStatus !== gitStatus) {
                state.files[filePath].gitStatus = gitStatus;
                changed = true;
            }
            if (state.files[filePath].hash !== newHash && newHash !== '') {
                state.files[filePath].hash = newHash;
                if (state.files[filePath].status === 'validated') {
                    state.files[filePath].status = 'to_review';
                }
                changed = true;
            }
        }
    }

    if (changed) {
        writeState(workspaceRoot, state);
    }
    return changed;
}
