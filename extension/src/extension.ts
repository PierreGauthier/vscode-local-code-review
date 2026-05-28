import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewCommentController } from './commentController';
import { registerCommands } from './commands';
import { getModifiedFiles } from './git';
import { ReviewDecorationProvider, ReviewProvider } from './reviewProvider';
import { computeFileHash, readState, refreshHashes, relocateComments, writeState, ReviewState, ReviewSource } from './store';

export function activate(context: vscode.ExtensionContext): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    const reviewProvider = new ReviewProvider(workspaceRoot);
    const treeView = vscode.window.createTreeView('localCodeReview.filesView', {
        treeDataProvider: reviewProvider,
        showCollapseAll: false,
    });
    reviewProvider.setTreeView(treeView);

    const commentController = new ReviewCommentController(workspaceRoot);

    const updateFileInReviewContext = () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            vscode.commands.executeCommand('setContext', 'localCodeReview.fileInReview', false);
            return;
        }
        const state = readState(workspaceRoot);
        const filePath = path.relative(workspaceRoot, editor.document.uri.fsPath);
        const inReview = state?.files[filePath]?.status === 'to_review';
        vscode.commands.executeCommand('setContext', 'localCodeReview.fileInReview', inReview);
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateFileInReviewContext),
        vscode.window.registerFileDecorationProvider(new ReviewDecorationProvider()),
    );

    registerCommands(context, workspaceRoot, reviewProvider, commentController, updateFileInReviewContext);

    // Auto-start a review on activation if none exists and modified files are found
    if (!readState(workspaceRoot)) {
        const source = vscode.workspace.getConfiguration('localCodeReview').get<'working_diff' | 'last_commit'>('defaultSource') ?? 'working_diff';
        const currentFiles = getModifiedFiles(workspaceRoot, source);
        if (currentFiles.length > 0) {
            const files: ReviewState['files'] = {};
            for (const { filePath, gitStatus } of currentFiles) {
                files[filePath] = {
                    hash: computeFileHash(path.join(workspaceRoot, filePath)),
                    status: 'to_review',
                    gitStatus,
                    comments: [],
                };
            }
            writeState(workspaceRoot, { source, startedAt: new Date().toISOString(), files });
            reviewProvider.refresh();
        }
    }

    // Load all comment threads once at startup — populates the Comments panel
    commentController.updateReviewFiles(workspaceRoot);
    commentController.loadAll(workspaceRoot);

    const reviewStatePath = path.join(workspaceRoot, '.vscode', 'code-review.json');
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, '**/*'),
    );
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const handleChange = (uri: vscode.Uri) => {
        if (uri.fsPath === reviewStatePath) {
            return;
        }
        // Immediately un-validate if the changed file's hash differs
        if (uri.scheme === 'file') {
            const state = readState(workspaceRoot);
            const filePath = path.relative(workspaceRoot, uri.fsPath);
            const fileData = state?.files[filePath];
            if (fileData?.status === 'validated') {
                const newHash = computeFileHash(uri.fsPath);
                if (newHash && newHash !== fileData.hash) {
                    fileData.hash = newHash;
                    fileData.status = 'to_review';
                    writeState(workspaceRoot, state!);
                    reviewProvider.refresh();
                    updateFileInReviewContext();
                }
            }
            if (fileData) {
                const relocated = relocateComments(workspaceRoot, filePath);
                if (relocated) {
                    commentController.refreshForFile(filePath, vscode.Uri.file(uri.fsPath));
                }
            }
        }
        // Debounced full refresh (new files, git status)
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(
            () => onFileChange(workspaceRoot, reviewProvider, commentController, updateFileInReviewContext),
            10_000,
        );
    };
    watcher.onDidChange(handleChange);
    watcher.onDidCreate(handleChange);
    watcher.onDidDelete((uri) => {
        if (uri.fsPath === reviewStatePath) {
            return;
        }
        const state = readState(workspaceRoot);
        if (state) {
            const filePath = path.relative(workspaceRoot, uri.fsPath);
            if (state.files[filePath]) {
                delete state.files[filePath];
                writeState(workspaceRoot, state);
                commentController.clearForFile(filePath);
                reviewProvider.refresh();
                updateFileInReviewContext();
            }
        }
        handleChange(uri);
    });

    context.subscriptions.push(treeView, watcher, commentController.controller);
}

function onFileChange(
    workspaceRoot: string,
    reviewProvider: ReviewProvider,
    commentController: ReviewCommentController,
    updateContext: () => void,
): void {
    const state = readState(workspaceRoot);

    if (!state) {
        // No state yet — bootstrap one if there are modified files (mirrors the auto-start logic)
        const source = vscode.workspace.getConfiguration('localCodeReview').get<ReviewSource>('defaultSource') ?? 'working_diff';
        const currentFiles = getModifiedFiles(workspaceRoot, source);
        if (currentFiles.length > 0) {
            const files: ReviewState['files'] = {};
            for (const { filePath, gitStatus } of currentFiles) {
                files[filePath] = {
                    hash: computeFileHash(path.join(workspaceRoot, filePath)),
                    status: 'to_review',
                    gitStatus,
                    comments: [],
                };
            }
            writeState(workspaceRoot, { source, startedAt: new Date().toISOString(), files });
            commentController.updateReviewFiles(workspaceRoot);
            reviewProvider.refresh();
            updateContext();
        }
        return;
    }

    const currentFiles = getModifiedFiles(workspaceRoot, state.source);
    const changed = refreshHashes(workspaceRoot, currentFiles);
    if (changed) {
        commentController.updateReviewFiles(workspaceRoot);
        reviewProvider.refresh();
        updateContext();
    }
}

export function deactivate(): void {}
