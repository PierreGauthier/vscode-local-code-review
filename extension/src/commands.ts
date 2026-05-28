import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { discardFile, getModifiedFiles, getOriginalContent } from './git';
import { ReviewCommentController } from './commentController';
import { ReviewProvider, FileItem } from './reviewProvider';
import {
    addComment,
    computeFileHash,
    devalidateFile,
    readState,
    refreshHashes,
    resolveThread,
    validateFile,
    writeState,
    FileStatus,
    ReviewSource,
    ReviewState,
} from './store';

class GitContentProvider implements vscode.TextDocumentContentProvider {
    constructor(private readonly workspaceRoot: string) {}

    provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        return getOriginalContent(this.workspaceRoot, uri.path.replace(/^\//, ''));
    }
}

class EmptyContentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(): string {
        return '';
    }
}

function getNextToReview(workspaceRoot: string, currentFilePath: string): string | undefined {
    const state = readState(workspaceRoot);
    if (!state) {
        return undefined;
    }
    const toReview = Object.entries(state.files)
        .filter(([, f]) => f.status === 'to_review')
        .map(([fp]) => fp);
    if (toReview.length <= 1) {
        return undefined;
    }
    const currentIdx = toReview.indexOf(currentFilePath);
    if (currentIdx === -1) {
        return toReview[0];
    }
    return toReview[(currentIdx + 1) % toReview.length];
}

async function openNextFile(
    workspaceRoot: string,
    reviewProvider: ReviewProvider,
    currentFilePath?: string,
): Promise<void> {
    const state = readState(workspaceRoot);
    if (!state) {
        return;
    }
    const toReview = Object.entries(state.files)
        .filter(([, f]) => f.status === 'to_review')
        .map(([fp]) => fp);

    if (toReview.length === 0) {
        return;
    }
    const currentIdx = currentFilePath ? toReview.indexOf(currentFilePath) : -1;
    const nextFile = toReview[(currentIdx + 1) % toReview.length];
    if (nextFile && nextFile !== currentFilePath) {
        await vscode.commands.executeCommand('localCodeReview.openDiff', nextFile);
        reviewProvider.revealFile(nextFile);
    }
}

export function registerCommands(
    context: vscode.ExtensionContext,
    workspaceRoot: string,
    reviewProvider: ReviewProvider,
    commentController: ReviewCommentController,
    updateContext: () => void,
): void {
    const gitProvider = new GitContentProvider(workspaceRoot);
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('review-git', gitProvider),
        vscode.workspace.registerTextDocumentContentProvider('review-deleted', new EmptyContentProvider()),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('localCodeReview.resetValidation', async () => {
            const state = readState(workspaceRoot);
            if (!state) {
                return;
            }
            const validatedCount = Object.values(state.files).filter(f => f.status === 'validated').length;
            if (validatedCount === 0) {
                return;
            }
            const choice = await vscode.window.showWarningMessage(
                `Reset ${validatedCount} validated file(s) back to "to review"?`,
                { modal: true },
                'Reset',
            );
            if (choice !== 'Reset') {
                return;
            }
            for (const fileData of Object.values(state.files)) {
                if (fileData.status === 'validated') {
                    fileData.status = 'to_review';
                }
            }
            writeState(workspaceRoot, state);
            reviewProvider.refresh();
            updateContext();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('localCodeReview.nextFile', async () => {
            await openNextFile(workspaceRoot, reviewProvider, getActiveFilePath(workspaceRoot));
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'localCodeReview.devalidateFile',
            async (filePathOrItem?: string | FileItem | vscode.CommentThread) => {
                const filePath =
                    extractFilePath(filePathOrItem, workspaceRoot) ??
                    (await pickFile(workspaceRoot, 'validated'));
                if (!filePath) {
                    return;
                }
                if (devalidateFile(workspaceRoot, filePath)) {
                    reviewProvider.refresh();
                    updateContext();
                }
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'localCodeReview.discardChanges',
            async (filePathOrItem?: string | FileItem) => {
                const filePath =
                    extractFilePath(filePathOrItem, workspaceRoot) ?? (await pickFile(workspaceRoot));
                if (!filePath) {
                    return;
                }
                const choice = await vscode.window.showWarningMessage(
                    `Discard all changes to "${path.basename(filePath)}"? This cannot be undone.`,
                    { modal: true },
                    'Discard',
                );
                if (choice !== 'Discard') {
                    return;
                }
                await discardFile(workspaceRoot, filePath);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('localCodeReview.refresh', () => {
            const state = readState(workspaceRoot);
            if (!state) {
                vscode.window.showWarningMessage('No active review.');
                return;
            }
            const currentFiles = getModifiedFiles(workspaceRoot, state.source);
            refreshHashes(workspaceRoot, currentFiles);
            reviewProvider.refresh();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'localCodeReview.openDiff',
            async (filePathOrItem: string | FileItem) => {
                const filePath =
                    filePathOrItem instanceof FileItem
                        ? filePathOrItem.filePath
                        : filePathOrItem;

                const absolutePath = path.join(workspaceRoot, filePath);
                const deleted = !fs.existsSync(absolutePath);
                const originalUri = vscode.Uri.parse(`review-git:/${filePath}`);
                const modifiedUri = deleted
                    ? vscode.Uri.parse(`review-deleted:/${filePath}`)
                    : vscode.Uri.file(absolutePath);
                const title = deleted
                    ? `${path.basename(filePath)} (deleted)`
                    : `${path.basename(filePath)} (review diff)`;

                await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title);
                commentController.loadForFile(filePath, modifiedUri);
                reviewProvider.revealFile(filePath);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'localCodeReview.validateFile',
            async (filePathOrItem?: string | FileItem | vscode.CommentThread) => {
                const filePath =
                    extractFilePath(filePathOrItem, workspaceRoot) ??
                    getActiveFilePath(workspaceRoot) ??
                    (await pickFile(workspaceRoot, 'to_review'));
                if (!filePath) {
                    return;
                }

                const state = readState(workspaceRoot);
                if (!state) {
                    return;
                }

                const openCount =
                    state.files[filePath]?.comments.filter(c => c.status === 'open').length ?? 0;

                let force = false;
                if (openCount > 0) {
                    const choice = await vscode.window.showWarningMessage(
                        `${openCount} open comment(s) on this file. Validate anyway?`,
                        { modal: true },
                        'Validate',
                    );
                    if (choice !== 'Validate') {
                        return;
                    }
                    force = true;
                }

                // Compute next file BEFORE validating (while current is still in to_review list)
                const nextFilePath = getNextToReview(workspaceRoot, filePath);

                const result = validateFile(workspaceRoot, filePath, force);
                if (result.ok) {
                    reviewProvider.refresh();
                    checkAllValidated(workspaceRoot);
                    if (nextFilePath) {
                        await vscode.commands.executeCommand('localCodeReview.openDiff', nextFilePath);
                        reviewProvider.revealFile(nextFilePath);
                    }
                } else {
                    vscode.window.showErrorMessage(result.reason ?? 'Error.');
                }
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'localCodeReview.addComment',
            async (filePathOrItem?: string | FileItem) => {
                const filePath =
                    extractFilePath(filePathOrItem, workspaceRoot) ?? (await pickFile(workspaceRoot));
                if (!filePath) {
                    return;
                }

                const content = await vscode.window.showInputBox({
                    prompt: `Comment on ${path.basename(filePath)}`,
                    placeHolder: 'Your review feedback...',
                    ignoreFocusOut: true,
                });
                if (!content?.trim()) {
                    return;
                }

                const lineStr = await vscode.window.showInputBox({
                    prompt: 'Line number (optional — press Enter to skip)',
                    placeHolder: 'e.g. 42',
                    ignoreFocusOut: true,
                });
                const line = lineStr ? parseInt(lineStr, 10) || undefined : undefined;

                const comment = addComment(workspaceRoot, filePath, content.trim(), 'me', line);
                if (comment) {
                    reviewProvider.refresh();
                    const modifiedUri = vscode.Uri.file(path.join(workspaceRoot, filePath));
                    commentController.refreshForFile(filePath, modifiedUri);
                }
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'localCodeReview.resolveComment',
            async (filePathOrItem?: string | FileItem | vscode.CommentThread) => {
                const filePath =
                    extractFilePath(filePathOrItem, workspaceRoot) ??
                    (await pickFile(workspaceRoot));
                if (!filePath) {
                    return;
                }

                const state = readState(workspaceRoot);
                if (!state) {
                    return;
                }

                // When called from a CommentThread: resolve root + all its replies in one write
                const thread = filePathOrItem instanceof FileItem || typeof filePathOrItem === 'string'
                    ? undefined
                    : filePathOrItem as vscode.CommentThread | undefined;

                let changed = false;
                if (thread?.range != null) {
                    const threadLine = thread.range.start.line + 1;
                    changed = resolveThread(workspaceRoot, filePath, threadLine);
                } else {
                    // Called from tree view: resolve all open root comments on the file
                    const roots = state.files[filePath]?.comments.filter(
                        c => !c.parent_id && c.status === 'open',
                    ) ?? [];
                    for (const c of roots) {
                        if (resolveThread(workspaceRoot, filePath, c.line)) {
                            changed = true;
                        }
                    }
                }

                if (changed) {
                    reviewProvider.refresh();
                    const modifiedUri = vscode.Uri.file(path.join(workspaceRoot, filePath));
                    commentController.collapseResolved(filePath);
                    commentController.refreshForFile(filePath, modifiedUri);
                }
            },
        ),
    );

    // Inline comment submission (from diff view — CommentThread reply)
    // Uses thread.uri + thread.range instead of thread.label to support new threads
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'localCodeReview.submitComment',
            async (reply: vscode.CommentReply | undefined) => {
                if (!reply) {
                    return;
                }
                const text = reply.text?.trim();
                if (!text) {
                    return;
                }

                const thread = reply.thread;
                if (thread.uri.scheme !== 'file') {
                    return;
                }

                let state = readState(workspaceRoot);
                if (!state) {
                    const source = vscode.workspace.getConfiguration('localCodeReview').get<ReviewSource>('defaultSource') ?? 'working_diff';
                    const currentFiles = getModifiedFiles(workspaceRoot, source);
                    const files: ReviewState['files'] = {};
                    for (const { filePath: fp, gitStatus } of currentFiles) {
                        files[fp] = { hash: computeFileHash(path.join(workspaceRoot, fp)), status: 'to_review', gitStatus, comments: [] };
                    }
                    state = { source, startedAt: new Date().toISOString(), files };
                    writeState(workspaceRoot, state);
                    reviewProvider.refresh();
                }

                const filePath = path.relative(workspaceRoot, thread.uri.fsPath);

                if (!state.files[filePath]) {
                    const choice = await vscode.window.showWarningMessage(
                        `"${path.basename(filePath)}" is not in the review. Add it?`,
                        { modal: true },
                        'Add',
                    );
                    if (choice !== 'Add') {
                        thread.dispose();
                        return;
                    }
                    const absolutePath = path.join(workspaceRoot, filePath);
                    state.files[filePath] = {
                        hash: computeFileHash(absolutePath),
                        status: 'to_review',
                        comments: [],
                    };
                    writeState(workspaceRoot, state);
                    commentController.updateReviewFiles(workspaceRoot);
                    reviewProvider.refresh();
                }

                const line = thread.range?.start.line != null
                    ? thread.range.start.line + 1
                    : undefined;

                let lineContent: string | undefined;
                if (line !== undefined) {
                    try {
                        const doc = vscode.workspace.textDocuments.find(
                            d => d.uri.toString() === thread.uri.toString(),
                        );
                        lineContent = doc?.lineAt(line - 1).text;
                    } catch {
                        // lineContent reste undefined si la ligne est hors limites
                    }
                }

                const comment = addComment(workspaceRoot, filePath, text, 'me', line, lineContent);
                if (comment) {
                    thread.dispose();
                    if (line !== undefined) {
                        commentController.forgetThread(filePath, line);
                    }
                    reviewProvider.refresh();
                    const modifiedUri = vscode.Uri.file(thread.uri.fsPath);
                    commentController.refreshForFile(filePath, modifiedUri);
                }
            },
        ),
    );
}

async function pickFile(workspaceRoot: string, statusFilter?: FileStatus): Promise<string | undefined> {
    const state = readState(workspaceRoot);
    if (!state) {
        vscode.window.showErrorMessage('No active review.');
        return undefined;
    }

    const files = Object.entries(state.files)
        .filter(([, f]) => !statusFilter || f.status === statusFilter)
        .map(([filePath]) => filePath);

    if (files.length === 0) {
        return undefined;
    }
    if (files.length === 1) {
        return files[0];
    }

    return vscode.window.showQuickPick(files, { placeHolder: 'Select a file' });
}

function getActiveFilePath(workspaceRoot: string): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
        return undefined;
    }
    return path.relative(workspaceRoot, editor.document.uri.fsPath);
}

function extractFilePath(
    arg: string | FileItem | vscode.CommentThread | undefined,
    workspaceRoot: string,
): string | undefined {
    if (arg instanceof FileItem) {
        return arg.filePath;
    }
    if (typeof arg === 'string') {
        return arg;
    }
    if (arg && typeof arg === 'object' && 'uri' in arg) {
        const thread = arg as vscode.CommentThread;
        if (thread.uri.scheme === 'file') {
            return path.relative(workspaceRoot, thread.uri.fsPath);
        }
    }
    return undefined;
}

function checkAllValidated(workspaceRoot: string): void {
    const state = readState(workspaceRoot);
    if (!state) {
        return;
    }

    const pending = Object.values(state.files).filter(f => f.status !== 'validated');

    if (pending.length === 0) {
        vscode.window.showInformationMessage('🎉 All files validated! Review complete.');
    }
}
