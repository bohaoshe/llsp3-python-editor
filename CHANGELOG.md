# Changelog

## 1.0.0

- Open LLSP3 Python projects as editable Python documents from Explorer.
- Preserve project metadata and unrelated ZIP entries when saving.
- Protect saves with conflict detection, cross-process locking, and recoverable
  file replacement.
- Compare Staged Changes as upstream remote to Git index.
- Compare unstaged Changes as Git index to editable working tree.
- Support new, renamed, staged-only, local, WSL, SSH, and Codespaces projects.
- Provide optional readable command-line Git diffs through a text conversion
  driver.
