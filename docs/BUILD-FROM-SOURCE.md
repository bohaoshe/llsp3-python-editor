# Build the LLSP3 Python Editor from Downloaded Source

Use this guide when you downloaded or cloned the complete repository and want
to build, test, package, and install the extension.

For an architectural guide to recreating the implementation from an empty
folder, see [Rebuild from Scratch](BUILD-FROM-SCRATCH.md).

## 1. Install prerequisites

Required:

- Visual Studio Code (https://code.visualstudio.com/download) 1.136 or newer.
- Node.js (https://nodejs.org) 22 or newer.
- npm 10 or newer.
- Git (https://git-scm.com/install/).

Check the installed versions:

```powershell
node --version
npm --version
git --version
code --version
```

If `code` is not recognized, open VS Code and add its command-line executable
to `PATH`, or run the commands with the full path to `Code.exe`.

## 2. Get the source

### Option A: Clone with Git

```powershell
git clone <repository-url>
Set-Location <downloaded-repository-folder>
```

### Option B: Download a ZIP

1. Download the repository ZIP.
2. Extract the entire ZIP.
3. Open PowerShell in the extracted root folder.

The root folder is correct when it contains:

```text
package.json
package-lock.json
tsconfig.json
src/
test/
resources/
```

Do not run the build from inside `src` or another subdirectory.

## 3. Restore exact dependencies

Use `npm ci` because the repository includes `package-lock.json`:

```powershell
npm ci
```

`npm ci` removes an existing `node_modules` directory and restores the exact
dependency versions recorded by the project.

Use `npm install` only when intentionally changing dependencies.

## 4. Compile the extension

```powershell
npm run compile
```

Compiled JavaScript and source maps are written under:

```text
dist/
```

To keep TypeScript compilation running while editing:

```powershell
npm run watch
```

Stop watch mode with **Ctrl+C**.

## 5. Run unit tests

```powershell
npm test
```

This command:

1. Deletes the previous `dist` folder.
2. Compiles TypeScript.
3. Runs the archive, text-conversion, and conditional-save tests.

## 6. Run the VS Code integration tests

```powershell
npm run test:integration
```

The integration suite creates temporary Git repositories and starts an
isolated VS Code Extension Host. It verifies:

- Explorer opens embedded Python.
- Staged Changes compares remote to the Git index.
- Changes compares the Git index to the working tree.
- The editable diff side saves back to the `.llsp3`.
- New files can use an upstream remote baseline.
- Rename and Source Control command edge cases.

The runner normally locates VS Code automatically. If it cannot, set:

```powershell
$env:VSCODE_EXECUTABLE_PATH = "C:\Program Files\Microsoft VS Code\Code.exe"
npm run test:integration
```

For a per-user VS Code installation, the path is commonly:

```text
%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe
```

The test runner writes temporary extension-host data under `.vscode-test/`.
That directory is generated and should not be committed.

## 7. Run the extension in development mode

1. Open the repository root in VS Code.
2. Press **F5**.
3. Select **Run LLSP3 Extension** if prompted.
4. In the Extension Development Host, open a folder containing an `.llsp3`
   Python project.

Expected behavior:

- Explorer opens the embedded Python source.
- Source Control Staged Changes opens remote-to-index Python diffs.
- Source Control Changes opens index-to-working-tree Python diffs.

Set breakpoints in `src/**/*.ts`. Source maps connect the compiled JavaScript
back to the TypeScript source.

## 8. Create the VSIX package

```powershell
npm run package
```

The command cleans, compiles, and runs `vsce package`. The generated file is:

```text
llsp3-python-editor-1.0.0.vsix
```

The VSIX contains compiled runtime files and runtime dependencies. Source and
test files are excluded by `.vscodeignore`.

## 9. Install the extension

```powershell
code --install-extension .\llsp3-python-editor-1.0.0.vsix --force
```

Confirm the installed identity:

```powershell
code --list-extensions --show-versions |
  Select-String "bohaoshe.llsp3-python-editor"
```

Expected output:

```text
bohaoshe.llsp3-python-editor@1.0.0
```

In VS Code, press **Ctrl+Shift+P**, run **Developer: Reload Window**, and then
test an `.llsp3` file.

## 10. Clean and rebuild

Delete compiled output:

```powershell
npm run clean
```

Perform a clean dependency restore and complete build:

```powershell
Remove-Item -LiteralPath node_modules -Recurse -Force
npm ci
npm run verify
npm run package
```

Only delete `node_modules`, `dist`, `.vscode-test`, or generated `.vsix` files.
Do not delete the repository root.

## 11. Common problems

### `npm ci` reports a lock-file mismatch

Confirm that both `package.json` and `package-lock.json` came from the same
source revision. Re-download the repository if one file is missing or was
modified.

### PowerShell blocks an npm script

Use the Windows command shim:

```powershell
npm.cmd ci
npm.cmd run compile
```

### `code` is not recognized

Use the full executable path:

```powershell
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" `
  --install-extension .\llsp3-python-editor-1.0.0.vsix --force
```

### Integration tests cannot find VS Code

Set `VSCODE_EXECUTABLE_PATH` to the full `Code.exe` path before running the
test.

### Source Control comparison cannot fetch

Run:

```powershell
git fetch
```

Resolve any Git authentication or network error, then retry the staged
comparison. Fetching does not push changes.

### The extension opens archive data instead of Python

1. Confirm the installed extension version.
2. Run **Developer: Reload Window**.
3. In Explorer, right-click the file and select **Reopen Editor With**.
4. Select **LLSP3 Python Project** and set it as the default.

### Source Control still shows a binary diff

1. Confirm the extension is enabled for the current workspace.
2. Confirm the workspace is trusted.
3. Reload the VS Code window.
4. Refresh Source Control.

### The project is rejected

The extension supports current LLSP3 Python projects containing
`manifest.json` with `"type": "python"` and `projectbody.json` with a string
`main` property. Word Blocks, Icon Blocks, encrypted ZIPs, ZIP64 archives, and
malformed archives are intentionally rejected.

## 12. Release checklist

Before distributing a newly built VSIX:

```powershell
npm ci
npm run verify
npm run package
```

Then install the VSIX into a clean VS Code profile and confirm:

- `bohaoshe.llsp3-python-editor` is the installed extension ID.
- Explorer opens embedded Python.
- Staged Changes shows remote to index.
- Changes shows index to working tree.
- Saving the working-tree side updates the archive.
