import * as path from 'path';
import * as vscode from 'vscode';
import { readState, ReviewFile } from './store';

type ReviewTreeItem = FolderItem | FileItem;

export class ReviewDecorationProvider implements vscode.FileDecorationProvider {
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        switch (uri.scheme) {
            case 'review-validated':
                return { color: new vscode.ThemeColor('disabledForeground') };
            case 'review-modified':
                return { color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') };
            case 'review-deleted':
                return { color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground') };
            case 'review-added':
                return { color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground') };
            default:
                return undefined;
        }
    }
}

export class ReviewProvider implements vscode.TreeDataProvider<ReviewTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ReviewTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private treeView?: vscode.TreeView<ReviewTreeItem>;
    private parentMap = new Map<string, ReviewTreeItem>();

    constructor(private readonly workspaceRoot: string) {}

    setTreeView(view: vscode.TreeView<ReviewTreeItem>): void {
        this.treeView = view;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
        this.updateProgress();
    }

    revealFile(filePath: string): void {
        if (!this.treeView) {
            return;
        }
        const state = readState(this.workspaceRoot);
        if (!state?.files[filePath]) {
            return;
        }
        const item = new FileItem(filePath, state.files[filePath], this.workspaceRoot);
        this.treeView.reveal(item, { select: true, focus: false }).then(undefined, () => {});
    }

    getParent(element: ReviewTreeItem): ReviewTreeItem | undefined {
        return element.id ? this.parentMap.get(element.id) : undefined;
    }

    getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ReviewTreeItem): ReviewTreeItem[] {
        if (element instanceof FolderItem) {
            return element.children;
        }
        if (element) {
            return [];
        }

        const state = readState(this.workspaceRoot);
        if (!state) {
            const placeholder = new vscode.TreeItem(
                'No active review',
                vscode.TreeItemCollapsibleState.None,
            );
            placeholder.description = 'Open a workspace with git changes';
            return [placeholder as ReviewTreeItem];
        }

        const entries = Object.entries(state.files);
        if (entries.length === 0) {
            return [
                new vscode.TreeItem(
                    'No modified files',
                    vscode.TreeItemCollapsibleState.None,
                ) as ReviewTreeItem,
            ];
        }

        const toReview = entries.filter(([, f]) => f.status === 'to_review');
        const validated = entries.filter(([, f]) => f.status === 'validated');

        const items = compactFolders(
            buildTree([...toReview, ...validated], this.workspaceRoot),
        );
        this.parentMap.clear();
        populateParentMap(items, undefined, this.parentMap);
        return items;
    }

    private updateProgress(): void {
        if (!this.treeView) {
            return;
        }
        const state = readState(this.workspaceRoot);
        if (!state) {
            this.treeView.badge = undefined;
            this.treeView.description = undefined;
            return;
        }
        const total = Object.values(state.files).length;
        const validated = Object.values(state.files).filter(f => f.status === 'validated').length;
        const pending = total - validated;

        this.treeView.description = `${validated}/${total}`;
        this.treeView.badge = pending > 0
            ? { value: pending, tooltip: `${pending} file(s) left to review` }
            : undefined;
    }
}

function populateParentMap(
    items: ReviewTreeItem[],
    parent: ReviewTreeItem | undefined,
    map: Map<string, ReviewTreeItem>,
): void {
    for (const item of items) {
        if (parent && item.id) {
            map.set(item.id, parent);
        }
        if (item instanceof FolderItem) {
            populateParentMap(item.children, item, map);
        }
    }
}

function buildTree(
    entries: Array<[string, ReviewFile]>,
    workspaceRoot: string,
    prefix = '',
): ReviewTreeItem[] {
    const dirGroups = new Map<string, Array<[string, ReviewFile]>>();
    const files: Array<[string, ReviewFile]> = [];

    for (const [filePath, fileData] of entries) {
        const normalized = filePath.replace(/\\/g, '/');
        const rel = prefix ? normalized.slice(prefix.length + 1) : normalized;
        const slashIdx = rel.indexOf('/');

        if (slashIdx === -1) {
            files.push([filePath, fileData]);
        } else {
            const dirName = rel.slice(0, slashIdx);
            const key = prefix ? `${prefix}/${dirName}` : dirName;
            if (!dirGroups.has(key)) {
                dirGroups.set(key, []);
            }
            dirGroups.get(key)!.push([filePath, fileData]);
        }
    }

    const items: ReviewTreeItem[] = [];

    for (const [fullDirPath, dirEntries] of dirGroups) {
        const name = path.basename(fullDirPath);
        const children = buildTree(dirEntries, workspaceRoot, fullDirPath);
        items.push(new FolderItem(name, children, fullDirPath));
    }

    for (const [filePath, fileData] of files) {
        items.push(new FileItem(filePath, fileData, workspaceRoot));
    }

    return items;
}

function compactFolders(items: ReviewTreeItem[]): ReviewTreeItem[] {
    return items.map(item => {
        if (!(item instanceof FolderItem)) {
            return item;
        }
        const compacted = compactFolders(item.children);
        if (compacted.length === 1 && compacted[0] instanceof FolderItem) {
            const child = compacted[0];
            return new FolderItem(`${item.dirName}/${child.dirName}`, child.children, child.fullPath);
        }
        return new FolderItem(item.dirName, compacted, item.fullPath);
    });
}

function countInSubtree(children: ReviewTreeItem[]): { total: number; toReview: number } {
    let total = 0;
    let toReview = 0;
    for (const child of children) {
        if (child instanceof FileItem) {
            total++;
            if (child.contextValue === 'file_to_review') {
                toReview++;
            }
        } else if (child instanceof FolderItem) {
            const sub = countInSubtree(child.children);
            total += sub.total;
            toReview += sub.toReview;
        }
    }
    return { total, toReview };
}

export class FolderItem extends vscode.TreeItem {
    constructor(
        public readonly dirName: string,
        public readonly children: ReviewTreeItem[],
        public readonly fullPath: string = dirName,
    ) {
        super(dirName, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'folder';

        const { total, toReview } = countInSubtree(children);
        this.description = toReview > 0 ? `${toReview}/${total}` : `✓ ${total}`;
        this.collapsibleState = toReview === 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded;
        this.id = `__dir_${toReview > 0 ? 'active' : 'done'}__${fullPath}`;
    }
}

export class FileItem extends vscode.TreeItem {
    constructor(
        public readonly filePath: string,
        fileData: ReviewFile,
        workspaceRoot: string,
    ) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
        this.id = filePath;

        this.contextValue = fileData.status === 'validated' ? 'file_validated' : 'file_to_review';

        const openCount = fileData.comments.filter(c => c.status === 'open').length;

        this.tooltip = new vscode.MarkdownString(
            `**${filePath}**\n\nStatus: ${fileData.status}` +
                (openCount > 0 ? `\n\n${openCount} open comment(s)` : ''),
        );

        const encoded = filePath.replace(/\\/g, '/');
        if (fileData.status === 'validated') {
            this.resourceUri = vscode.Uri.parse(`review-validated:/${encoded}`);
        } else {
            const scheme =
                fileData.gitStatus === 'A' ? 'review-added'
                : fileData.gitStatus === 'D' ? 'review-deleted'
                : 'review-modified';
            this.resourceUri = vscode.Uri.parse(`${scheme}:/${encoded}`);
            if (openCount > 0) {
                this.description = `${openCount} 💬`;
            }
        }

        this.command = {
            command: 'localCodeReview.openDiff',
            title: 'Open diff',
            arguments: [filePath],
        };
    }
}
