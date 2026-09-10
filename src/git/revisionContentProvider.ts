import { createHash } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';

export const LLSP3_GIT_SCHEME = 'llsp3-git';

export class GitRevisionContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly content = new Map<string, string>();

  public readonly onDidChange = this.changeEmitter.event;

  public create(
    container: vscode.Uri,
    revision: string,
    source: string,
  ): vscode.Uri {
    const baseName =
      path.posix.basename(
        container.path,
        path.posix.extname(container.path),
      ) || 'LLSP3 Project';
    const key = createHash('sha256')
      .update(`${container.toString()}\0${revision}`)
      .digest('hex');
    const uri = vscode.Uri.from({
      scheme: LLSP3_GIT_SCHEME,
      path: `/${baseName} (${revision}).py`,
      query: new URLSearchParams({ key }).toString(),
    });
    const previous = this.content.get(key);
    this.content.set(key, source);
    if (previous !== undefined && previous !== source) {
      this.changeEmitter.fire(uri);
    }
    return uri;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const key = new URLSearchParams(uri.query).get('key');
    const source = key === null ? undefined : this.content.get(key);
    if (source === undefined) {
      throw new Error('The requested LLSP3 Git revision is no longer available.');
    }
    return source;
  }

  public dispose(): void {
    this.content.clear();
    this.changeEmitter.dispose();
  }
}
