# Rebuild the LLSP3 Python Editor from Scratch

This guide explains how to recreate the extension from an empty directory. It
focuses on the architecture, implementation order, and safety requirements. If
you already downloaded this repository and only need to build it, use
[Build from Source](BUILD-FROM-SOURCE.md).

## 1. Prerequisites

Install:

- Visual Studio Code 1.136 or newer.
- Node.js 22 or newer.
- npm 10 or newer.
- Git.

Verify the tools:

```powershell
node --version
npm --version
git --version
code --version
```

## 2. Understand the supported LLSP3 format

A supported LEGO Education SPIKE Python project is a ZIP archive:

```text
project.llsp3
├── manifest.json
├── projectbody.json
├── icon.svg
└── other optional entries
```

The project must have:

```json
{
  "type": "python"
}
```

in `manifest.json`, and:

```json
{
  "main": "print(\"Hello\")\n"
}
```

in `projectbody.json`.

The extension edits only `projectbody.json/main`. It must preserve all other
archive entries and metadata. Word Blocks and Icon Blocks projects must be
rejected instead of rewritten as Python projects.

## 3. Create the project

```powershell
New-Item -ItemType Directory llsp3-python-editor
Set-Location llsp3-python-editor
npm init -y
```

Install runtime dependencies:

```powershell
npm install jsonc-parser proper-lockfile
```

Install development dependencies:

```powershell
npm install --save-dev typescript @types/node @types/vscode `
  @types/proper-lockfile @types/mocha mocha `
  @vscode/test-electron @vscode/vsce
```

Create this layout:

```text
llsp3-python-editor/
├── .vscode/
│   ├── launch.json
│   └── tasks.json
├── docs/
├── resources/
│   └── llsp3-textconv.cjs
├── src/
│   ├── extension.ts
│   ├── git/
│   │   ├── gitSupport.ts
│   │   ├── revisionContentProvider.ts
│   │   └── scmResourceIntegration.ts
│   └── llsp3/
│       ├── archive.ts
│       ├── conditionalFileReplace.ts
│       ├── fileSystemProvider.ts
│       ├── projectEditor.ts
│       └── uri.ts
├── test/
│   ├── archive.test.ts
│   ├── integrationRunner.ts
│   └── integration/
│       ├── index.ts
│       └── suite.ts
├── package.json
└── tsconfig.json
```

## 4. Configure TypeScript

Use Node 16 module resolution with an ES2022 target. Enable strict checks,
including unchecked-index and exact-optional-property checks:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

## 5. Configure the extension manifest

The important `package.json` settings are:

- `main`: `./dist/src/extension.js`
- `engines.vscode`: `^1.136.0`
- `publisher` and `author`: `bohaoshe`
- `onCustomEditor:llsp3.projectEditor` activation
- `onFileSystem:llsp3` activation
- an `*.llsp3` custom-editor association
- commands for opening Python and Git comparisons

Use these scripts:

```json
{
  "scripts": {
    "clean": "node -e \"require('node:fs').rmSync('dist',{recursive:true,force:true})\"",
    "build": "npm run compile",
    "compile": "tsc -p .",
    "watch": "tsc -p . --watch",
    "pretest": "npm run clean && npm run compile",
    "test": "node --test dist/test/archive.test.js",
    "test:integration": "npm run clean && npm run compile && node dist/test/integrationRunner.js",
    "verify": "npm test && npm run test:integration",
    "package": "npm run clean && npm run compile && vsce package --baseContentUrl https://github.com/bohaoshe/llsp3-python-editor --baseImagesUrl https://github.com/bohaoshe/llsp3-python-editor"
  }
}
```

The complete manifest in this repository should be treated as the reference
when reproducing command IDs, menus, workspace-trust declarations, and the
custom-editor selector.

## 6. Implement the archive codec

Build `src/llsp3/archive.ts` first. It is the foundation for every other
feature.

The codec must:

1. Find and parse the ZIP end-of-central-directory record.
2. Reject ZIP64, multi-disk, encrypted, malformed, and unsupported archives.
3. Read `manifest.json` and verify `type` is `python`.
4. Read `projectbody.json` and verify `main` is a string.
5. Validate uncompressed sizes and CRC32 values.
6. Replace only the `main` JSON value.
7. Copy unchanged ZIP local records byte-for-byte.
8. Rebuild offsets and checksums only where required.
9. Preserve entry order, comments, timestamps, attributes, extra fields, and
   unknown entries.
10. Reopen and verify the resulting archive before returning it.

Do not use an extract-and-rebuild implementation that silently drops unknown
entries. A normal ZIP library is useful for prototyping, but many libraries
rewrite timestamps, ordering, comments, attributes, and compressed bytes.

## 7. Expose the Python source as a writable virtual file

Implement `src/llsp3/fileSystemProvider.ts` as a
`vscode.FileSystemProvider`.

Use a URI such as:

```text
llsp3:/Project.py?container=<encoded-container-uri>
```

The `.py` suffix lets VS Code treat the virtual document as Python.

Implement:

- `stat`
- `watch`
- `readFile`
- `writeFile`

`readFile` extracts `projectbody.json/main`. `writeFile` updates the original
archive.

Persist an archive hash and source hash as the document baseline. Refuse to
overwrite the archive if both the editor and an external process changed the
embedded source.

## 8. Make saves recoverable

Implement `src/llsp3/conditionalFileReplace.ts`.

The save path must:

1. Acquire a cross-process file lock.
2. Write and flush a uniquely named temporary file.
3. Move the current archive to a uniquely named backup.
4. Verify the displaced archive still matches the expected hash.
5. Link or install the edited archive at the original path.
6. Verify both the installed archive and backup.
7. Delete recovery files only after successful verification.

If any step fails, retain the relevant recovery files and include their paths
in the error. Never delete the only valid copy of the project.

## 9. Redirect Explorer opens to Python

Register a readonly custom editor for `*.llsp3` in
`src/llsp3/projectEditor.ts`.

When VS Code resolves the custom editor:

1. Validate the archive.
2. Open the writable `llsp3:` Python document.
3. Close the temporary custom-editor panel.

The result is that clicking or double-clicking an `.llsp3` file in Explorer
opens Python instead of binary ZIP data.

## 10. Implement Git object access

Implement `src/git/gitSupport.ts` using the Git executable selected by VS
Code's built-in Git extension.

Required Git reads:

```powershell
# Staged version
git show :path/to/project.llsp3

# A committed or remote version
git show <revision>:path/to/project.llsp3
```

Source Control behavior must match the selected group:

| Source Control group | Left side | Right side |
|---|---|---|
| Staged Changes | Fetched upstream remote | Git index |
| Changes | Git index | Working tree |
| Untracked with no index entry | Local HEAD, remote, or empty | Working tree |

Before opening a Staged Changes comparison, run:

```powershell
git fetch --quiet
```

This updates remote-tracking refs only. Do not run `git push`, create commits,
or mutate the index.

For renamed resources, carry both paths:

- Original path for the remote or old-index lookup.
- Destination path for the new index or working-tree lookup.

Stop after selecting the first existing upstream or preferred remote ref. If
the path is absent in that ref, show an empty left side instead of searching an
unrelated branch.

## 11. Integrate with Source Control rows

Implement `src/git/scmResourceIntegration.ts`.

The built-in Git extension owns the rows in Source Control. Change only the
default command for `.llsp3` resource states:

- `indexGroup` uses the staged-versus-remote command.
- `workingTreeGroup` uses the index-versus-working-tree command.
- `untrackedGroup` uses the unstaged fallback command.

Leave deleted resources on Git's built-in command.

VS Code may cache a resource's original command before this extension starts.
Wrap the resource state with `Object.create(resource)` and add the LLSP3 command
to the wrapper. This preserves `instanceof` behavior and avoids trying to
replace a non-configurable cached property.

## 12. Add the optional command-line Git diff driver

`resources/llsp3-textconv.cjs` extracts and prints only the embedded Python.
It is used by an optional repository-local Git diff configuration:

```gitattributes
*.llsp3 diff=llsp3
```

The helper must always exit successfully. For unsupported or corrupt archives,
print a short diagnostic and archive hash so one bad file cannot abort an
entire `git diff`.

## 13. Add tests

Unit tests should cover:

- Python extraction.
- Unicode and trailing newlines.
- No-op saves.
- ZIP record preservation.
- Signed and signatureless data descriptors.
- CRC/signature collisions.
- Invalid and non-Python projects.
- Text conversion success and safe fallback.
- Conditional replacement and simultaneous writers.

Extension Host tests should cover:

- Explorer opening an editable `llsp3:` Python document.
- Remote-to-index staged comparison.
- Index-to-working-tree unstaged comparison.
- Saving the right side back to the archive.
- Upstream fallback for a locally new file.
- Staged rename followed by unstaged edits.
- Git rows whose default command was already cached.
- Staged content without a working-tree file.
- Deleted-resource preservation.

## 14. Build, test, and package

```powershell
npm run compile
npm run verify
npm run package
```

Install the generated VSIX:

```powershell
code --install-extension .\llsp3-python-editor-1.0.0.vsix --force
```

Reload VS Code with **Developer: Reload Window**.

## 15. Completion checklist

- Explorer opens Python, not archive bytes.
- Saving Python updates the `.llsp3` file.
- Unrelated ZIP entries remain unchanged.
- Staged Changes shows remote to index.
- Changes shows index to working tree.
- The working-tree side remains editable.
- Git fetch never causes a push.
- Invalid archives fail with an actionable message.
- Concurrent edits do not silently overwrite each other.
- `npm test`, `npm run test:integration`, and `npm run package` succeed.
