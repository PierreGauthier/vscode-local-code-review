import * as path from 'path';
import * as vscode from 'vscode';
import { readState, ReviewComment, ReviewState } from './store';

export class ReviewCommentController {
    public readonly controller: vscode.CommentController;
    private threads = new Map<string, vscode.CommentThread>();
    private reviewFilePaths = new Set<string>();

    constructor(private readonly workspaceRoot: string) {
        this.controller = vscode.comments.createCommentController(
            'localCodeReview',
            'Local Code Review',
        );
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (doc: vscode.TextDocument) => {
                if (doc.uri.scheme !== 'file') {
                    return [];
                }
                const filePath = path.relative(workspaceRoot, doc.uri.fsPath);
                if (!this.reviewFilePaths.has(filePath)) {
                    return [];
                }
                return [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)];
            },
        };
        this.controller.options = {
            placeHolder: 'Your review comment...',
        };
    }

    updateReviewFiles(workspaceRoot: string): void {
        const state = readState(workspaceRoot);
        this.reviewFilePaths = new Set(state ? Object.keys(state.files) : []);
    }

    loadAll(workspaceRoot: string): void {
        const state = readState(workspaceRoot);
        if (!state) {
            this.clearAll();
            return;
        }
        for (const [filePath, fileData] of Object.entries(state.files)) {
            if (fileData.comments.length > 0) {
                const docUri = vscode.Uri.file(path.join(workspaceRoot, filePath));
                this.loadForFile(filePath, docUri, state);
            } else {
                this.clearForFile(filePath);
            }
        }
    }

    loadForFile(filePath: string, docUri: vscode.Uri, preloadedState?: ReviewState): void {
        const state = preloadedState ?? readState(this.workspaceRoot);
        if (!state) {
            this.clearForFile(filePath);
            return;
        }

        const fileData = state.files[filePath];
        if (!fileData || fileData.comments.length === 0) {
            this.clearForFile(filePath);
            return;
        }

        const roots = fileData.comments.filter(c => !c.parent_id);
        const byLine = new Map<number, ReviewComment[]>();

        for (const c of roots) {
            const lineKey = c.line ?? 0;
            if (!byLine.has(lineKey)) {
                byLine.set(lineKey, []);
            }
            byLine.get(lineKey)!.push(c);
        }

        // Remove threads for lines that no longer exist
        for (const [key, thread] of this.threads.entries()) {
            if (!key.startsWith(`${filePath}:`)) {
                continue;
            }
            const line = parseInt(key.slice(filePath.length + 1), 10);
            if (!byLine.has(line)) {
                thread.dispose();
                this.threads.delete(key);
            }
        }

        for (const [line, rootComments] of byLine) {
            const lineIndex = Math.max(0, line - 1);
            const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
            const vsComments: vscode.Comment[] = [];

            for (const root of rootComments) {
                vsComments.push(this.toVsComment(root, filePath));
                const replies = fileData.comments.filter(r => r.parent_id === root.id);
                for (const reply of replies) {
                    vsComments.push(this.toVsComment(reply, filePath));
                }
            }

            const allResolved = rootComments.every(c => c.status === 'resolved');
            const key = `${filePath}:${line}`;
            const existing = this.threads.get(key);

            if (existing) {
                // Update in place — avoids the scroll triggered by createCommentThread
                existing.comments = vsComments;
                existing.collapsibleState = allResolved
                    ? vscode.CommentThreadCollapsibleState.Collapsed
                    : vscode.CommentThreadCollapsibleState.Expanded;
                existing.state = allResolved
                    ? vscode.CommentThreadState.Resolved
                    : vscode.CommentThreadState.Unresolved;
            } else {
                const thread = this.controller.createCommentThread(docUri, range, vsComments);
                thread.collapsibleState = allResolved
                    ? vscode.CommentThreadCollapsibleState.Collapsed
                    : vscode.CommentThreadCollapsibleState.Expanded;
                thread.state = allResolved
                    ? vscode.CommentThreadState.Resolved
                    : vscode.CommentThreadState.Unresolved;
                thread.canReply = true;
                thread.contextValue = 'reviewThread';
                this.threads.set(key, thread);
            }
        }
    }

    forgetThread(filePath: string, line: number): void {
        this.threads.delete(`${filePath}:${line}`);
    }

    refreshForFile(filePath: string, docUri: vscode.Uri): void {
        this.loadForFile(filePath, docUri);
    }

    collapseResolved(filePath: string): void {
        for (const [key, thread] of this.threads.entries()) {
            if (key.startsWith(`${filePath}:`) && thread.state === vscode.CommentThreadState.Resolved) {
                thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
            }
        }
    }

    clearForFile(filePath: string): void {
        for (const [key, thread] of this.threads.entries()) {
            if (key.startsWith(`${filePath}:`)) {
                thread.dispose();
                this.threads.delete(key);
            }
        }
    }

    clearAll(): void {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
    }

    private toVsComment(c: ReviewComment, filePath: string): vscode.Comment {
        const isAi = c.author === 'ai';
        const authorIcon = isAi ? '🤖' : '👤';
        const authorLabel = isAi ? 'AI' : 'Me';
        const resolvedSuffix = c.status === 'resolved' ? ' ✅' : '';

        const comment: vscode.Comment = {
            author: { name: `${authorIcon} ${authorLabel}${resolvedSuffix}` },
            body: new vscode.MarkdownString(c.content),
            mode: vscode.CommentMode.Preview,
            label: c.status === 'resolved' ? 'Resolved' : undefined,
            contextValue: c.status === 'open' ? 'openComment' : 'resolvedComment',
        };
        // Store review metadata for inline resolve command
        (comment as vscode.Comment & { reviewCommentId: string; reviewFilePath: string }).reviewCommentId = c.id;
        (comment as vscode.Comment & { reviewCommentId: string; reviewFilePath: string }).reviewFilePath = filePath;
        return comment;
    }
}
