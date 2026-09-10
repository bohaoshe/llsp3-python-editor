import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readLlsp3Project, type Llsp3Project } from './archive';

export interface ProjectEditorActions {
  readonly openSource: (
    container: vscode.Uri,
    viewColumn?: vscode.ViewColumn,
  ) => Promise<void>;
  readonly compareWithHead: (
    container: vscode.Uri,
    viewColumn?: vscode.ViewColumn,
  ) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}

class Llsp3CustomDocument implements vscode.CustomDocument {
  public constructor(public readonly uri: vscode.Uri) {}

  public dispose(): void {}
}

export class Llsp3ProjectEditor
  implements vscode.CustomReadonlyEditorProvider<Llsp3CustomDocument>
{
  public constructor(private readonly actions: ProjectEditorActions) {}

  public openCustomDocument(uri: vscode.Uri): Llsp3CustomDocument {
    return new Llsp3CustomDocument(uri);
  }

  public async resolveCustomEditor(
    document: Llsp3CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };

    try {
      const archive = await vscode.workspace.fs.readFile(document.uri);
      const project = readLlsp3Project(archive);
      panel.webview.html = renderProjectHtml(panel.webview, document.uri, project);
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!isWebviewMessage(message)) {
          return;
        }

        if (message.command === 'open') {
          void this.actions
            .openSource(document.uri, panel.viewColumn)
            .catch(this.actions.reportError);
        } else if (message.command === 'compare') {
          void this.actions
            .compareWithHead(document.uri, panel.viewColumn)
            .catch(this.actions.reportError);
        }
      });

      setTimeout(() => {
        void this.actions
          .openSource(document.uri, panel.viewColumn)
          .then(() => panel.dispose())
          .catch(this.actions.reportError);
      }, 0);
    } catch (error) {
      panel.webview.html = renderErrorHtml(panel.webview, error);
      this.actions.reportError(error);
    }
  }
}

function renderProjectHtml(
  webview: vscode.Webview,
  uri: vscode.Uri,
  project: Llsp3Project,
): string {
  const nonce = randomBytes(16).toString('hex');
  const projectName =
    typeof project.manifest.name === 'string'
      ? project.manifest.name
      : uri.path.split('/').at(-1) ?? 'LLSP3 project';
  const hardware =
    typeof project.manifest.hardware === 'string'
      ? project.manifest.hardware
      : 'Not specified';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(projectName)}</title>
  <style>
    body { padding: 2rem; max-width: 52rem; margin: 0 auto; }
    h1 { margin-bottom: 0.25rem; }
    .muted { color: var(--vscode-descriptionForeground); }
    .card {
      margin: 1.5rem 0;
      padding: 1rem 1.25rem;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 0.35rem;
      background: var(--vscode-editorWidget-background);
    }
    dt { font-weight: 600; }
    dd { margin: 0 0 0.75rem; }
    button {
      margin: 0.5rem 0.5rem 0 0;
      padding: 0.45rem 0.8rem;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 0.2rem;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <h1>${escapeHtml(projectName)}</h1>
  <p class="muted">LLSP3 Python project</p>
  <div class="card">
    <dl>
      <dt>Container</dt>
      <dd>${escapeHtml(uri.fsPath || uri.path)}</dd>
      <dt>Hardware</dt>
      <dd>${escapeHtml(hardware)}</dd>
      <dt>Archive entries</dt>
      <dd>${project.entryNames.length}</dd>
    </dl>
    <p>
      Double-clicking opens an editable Python diff against local Git HEAD.
      Saving the working-tree side writes the source back into this project.
    </p>
    <button id="open">Open Python source</button>
    <button id="compare">Open Git diff</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('open').addEventListener('click', () => {
      vscode.postMessage({ command: 'open' });
    });
    document.getElementById('compare').addEventListener('click', () => {
      vscode.postMessage({ command: 'compare' });
    });
  </script>
</body>
</html>`;
}

function renderErrorHtml(webview: vscode.Webview, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';"
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cannot open LLSP3 project</title>
</head>
<body>
  <h1>Cannot open LLSP3 project</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function isWebviewMessage(
  value: unknown,
): value is { readonly command: 'open' | 'compare' } {
  if (typeof value !== 'object' || value === null || !('command' in value)) {
    return false;
  }
  return value.command === 'open' || value.command === 'compare';
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}
