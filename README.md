# LLSP3 Python Editor

An unofficial VS Code extension for opening LEGO Education SPIKE `.llsp3`
Python projects as normal Python documents.

## Features

- Click or double-click an `.llsp3` project in Explorer to open its editable
  embedded Python source.
- Double-click an `.llsp3` change in Source Control to open a native,
  side-by-side Python diff.
- Edit with VS Code's native Python editor, including syntax highlighting and
  Python extension features that support virtual file systems.
- Save changes back to `projectbody.json` without extracting a tracked sidecar
  file. Local projects use an atomic file replacement.
- Preserve `manifest.json`, icons, monitors, unknown entries, ZIP entry order,
  timestamps, attributes, comments, and the compressed bytes of unchanged
  entries.
- Detect conflicting external changes to the embedded source before saving.
- Compare the working embedded Python source with its selected Git baseline.
- Configure a repository-local Git text conversion driver for readable command
  line diffs.

## Usage

1. Open a folder containing an `.llsp3` project.
2. Click or double-click the project in Explorer to open the embedded Python.
3. Edit the generated virtual `.py` tab.
4. Save normally. The original `.llsp3` file is updated atomically and appears
   as modified in VS Code Source Control.

The virtual Python document is not a second file. Its contents are backed by the
`main` property in the archive's root `projectbody.json`.

In Source Control, the comparison follows the selected Git group:

1. **Staged Changes:** latest upstream remote version on the left, staged Git
   index version on the right.
2. **Changes:** staged Git index version on the left, editable working-tree
   version on the right.
3. If an unstaged file has no index entry, the extension falls back to local
   `HEAD`, then cached remote-tracking refs, then an empty baseline.

Opening a staged comparison runs `git fetch --quiet` first so the remote side is
current. Fetching updates remote-tracking refs only; it never pushes local
commits or files.

## Git integration

Saving updates the tracked `.llsp3` file directly, so normal Git status, stage,
commit, checkout, and restore operations continue to work.

Double-clicking an `.llsp3` change in Source Control automatically opens a
Python-aware comparison. This does not require `.gitattributes`, a textconv
driver, or other repository configuration.

Run **LLSP3: Configure Git Diff for This Repository** to add this line to the
repository's `.gitattributes`:

```gitattributes
*.llsp3 diff=llsp3
```

The command also installs a small Node.js text conversion helper under the
repository's private Git directory and configures it in local Git config. After
that, commands such as `git diff` show changes to the embedded Python source.
Node.js must be available on `PATH` when Git runs the helper.

Unsupported or malformed projects produce a short hash-based placeholder in
text conversion output, so one file cannot abort a repository-wide Git diff.

Git still stores and stages each `.llsp3` project as one binary archive.
Text conversion cannot provide line-level staging or automatic textual merges.

## Supported projects

The extension supports current Python projects with this structure:

```text
project.llsp3
├── manifest.json       # "type": "python"
└── projectbody.json    # { "main": "..." }
```

Word Blocks, Icon Blocks, encrypted archives, multi-disk archives, ZIP64
archives, and unsupported ZIP compression methods are rejected rather than
rewritten.

Editing requires a disk-backed local or remote workspace so saves can use
conditional replacement and retain recovery copies if another process changes
the project. WSL, SSH, and Codespaces are supported because the extension runs
alongside the workspace filesystem.

## Development

Build documentation:

- [Build the downloaded source](docs/BUILD-FROM-SOURCE.md)
- [Rebuild the project from scratch](docs/BUILD-FROM-SCRATCH.md)

```powershell
npm ci
npm run verify
npm run package
```

Press `F5` in VS Code to launch an Extension Development Host.

## Disclaimer

This project is unofficial and is not affiliated with or endorsed by the LEGO
Group. LEGO, SPIKE, and related marks belong to their respective owners.
