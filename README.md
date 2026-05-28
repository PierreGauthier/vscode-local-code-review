# Local Code Review

A VS Code extension for local, bidirectional code review with MCP server support for AI assistants.

Review your own git changes directly in VS Code. An AI assistant can read diffs, add comments, and validate files through the MCP server.

## Installation

### VS Code Extension

1. Download `extension/local-code-review-0.1.0.vsix`
2. In VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
3. Select the `.vsix` file

The extension activates automatically on startup and starts a review if modified files are detected in the workspace.

### MCP Server

The MCP server allows an AI assistant to interact with the current review.

**Requirements:** Python 3.10+

```bash
cd mcp
pip install -r requirements.txt
```

**Configuration** (e.g. `~/.config/claude/claude_desktop_config.json` or your MCP client config):

```json
{
  "mcpServers": {
    "code-review": {
      "command": "python",
      "args": ["/path/to/mcp/server.py"]
    }
  }
}
```

## Usage

### In VS Code

The **Code Review** icon in the activity bar shows files to review, grouped by directory.

| Action | How |
|--------|-----|
| Open diff | Click a file in the tree view |
| Add a comment | Click in the editor gutter |
| Submit a comment | **Submit** button or `Ctrl+Enter` |
| Validate a file | ✓ button in the editor title bar or right-click in the tree |
| Reset the review | ▶ button in the tree view (re-captures modified files) |
| Close comment popup | `Escape` |

### Via MCP

Available tools:

| Tool | Description |
|------|-------------|
| `get_review_summary` | Overall review progress |
| `list_files` | List files with their status |
| `get_file_diff` | Git diff for a file |
| `get_file_comments` | Comments on a file |
| `add_comment` | Add a comment (author: AI) |
| `resolve_comment` | Resolve an AI comment |
| `validate_file` | Validate a file (requires all comments resolved) |

All tools accept a `workspace` parameter (absolute path). Defaults to the current directory.

## How it works

The review state is stored in `.vscode/code-review.json` at the workspace root, shared between the VS Code extension and the MCP server.

- Human comments (from VS Code) have `author: "me"`
- AI comments (via MCP) have `author: "ai"`
- The AI can only resolve its own comments
- A file can only be validated when all its comments are resolved
- If a validated file is modified, it automatically reverts to `to_review`
