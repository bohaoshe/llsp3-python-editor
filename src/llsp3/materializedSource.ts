import { createHash } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { Llsp3FileSystemProvider } from './fileSystemProvider';
import { createSourceUri } from './uri';

interface MaterializedSource {
  readonly container: vscode.Uri;
  readonly source: vscode.Uri;
  readonly virtualSource: vscode.Uri;
  readonly watcher: vscode.Disposable;
}

const MATERIALIZED_SOURCES_STATE_KEY = 'llsp3.materializedSources';

export class Llsp3MaterializedSourceManager implements vscode.Disposable {
  private readonly sourcesByContainer = new Map<string, MaterializedSource>();
  private readonly sourcesByUri = new Map<string, MaterializedSource>();
  private readonly sourcesByVirtualUri = new Map<string, MaterializedSource>();
  private readonly willSaveVersions = new Map<string, number>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private statePersistence: Promise<void> = Promise.resolve();

  public constructor(
    private readonly storageRoot: vscode.Uri,
    private readonly state: vscode.Memento,
    private readonly fileSystemProvider: Llsp3FileSystemProvider,
    private readonly reportError: (error: unknown) => void,
  ) {
    const storedSources = state.get<Record<string, string>>(
      MATERIALIZED_SOURCES_STATE_KEY,
      {},
    );
    for (const [source, container] of Object.entries(storedSources)) {
      try {
        this.register(
          vscode.Uri.parse(container, true),
          vscode.Uri.parse(source, true),
        );
      } catch {
        // Ignore stale extension state that cannot be represented as a URI.
      }
    }

    this.subscriptions.push(
      vscode.workspace.onWillSaveTextDocument((event) => {
        const sourceKey = event.document.uri.toString();
        if (!this.sourcesByUri.has(sourceKey)) {
          return;
        }
        const documentVersion = event.document.version;
        event.waitUntil(
          this.synchronizeDocument(event.document).then(
            () => {
              this.willSaveVersions.set(sourceKey, documentVersion);
              return [];
            },
            (error: unknown) => {
              this.willSaveVersions.set(sourceKey, documentVersion);
              this.reportError(asSynchronizationError(error));
              return [];
            },
          ),
        );
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        const sourceKey = document.uri.toString();
        const source = this.sourcesByUri.get(sourceKey);
        if (source === undefined) {
          return;
        }
        const willSaveVersion = this.willSaveVersions.get(sourceKey);
        this.willSaveVersions.delete(sourceKey);
        if (willSaveVersion === document.version) {
          return;
        }
        void this.synchronizePhysicalFile(source).catch((error: unknown) => {
          this.reportError(asSynchronizationError(error));
        });
      }),
      this.fileSystemProvider.onDidChangeFile((events) => {
        for (const event of events) {
          if (event.type === vscode.FileChangeType.Deleted) {
            continue;
          }
          const source = this.sourcesByVirtualUri.get(event.uri.toString());
          if (source !== undefined) {
            void this.refresh(source).catch(this.reportError);
          }
        }
      }),
    );
  }

  public async open(container: vscode.Uri): Promise<vscode.Uri> {
    const containerKey = container.toString();
    let source = this.sourcesByContainer.get(containerKey);
    if (source === undefined) {
      source = this.register(container, this.createSourceUri(container));
      await this.persistState();
    }

    await this.refresh(source);
    return source.source;
  }

  public getContainer(source: vscode.Uri): vscode.Uri | undefined {
    return this.sourcesByUri.get(source.toString())?.container;
  }

  private register(
    container: vscode.Uri,
    source: vscode.Uri,
  ): MaterializedSource {
    const virtualSource = createSourceUri(container);
    const materialized: MaterializedSource = {
      container,
      source,
      virtualSource,
      watcher: this.fileSystemProvider.watch(virtualSource),
    };
    this.sourcesByContainer.set(container.toString(), materialized);
    this.sourcesByUri.set(source.toString(), materialized);
    this.sourcesByVirtualUri.set(virtualSource.toString(), materialized);
    this.subscriptions.push(materialized.watcher);
    return materialized;
  }

  private createSourceUri(container: vscode.Uri): vscode.Uri {
    const extension = path.posix.extname(container.path);
    const baseName =
      path.posix.basename(container.path, extension) || 'LLSP3 Project';
    const containerHash = createHash('sha256')
      .update(container.toString())
      .digest('hex');
    const source = vscode.Uri.joinPath(
      this.storageRoot,
      'python',
      containerHash,
      `${baseName}.py`,
    );
    return container.scheme === 'vscode-remote'
      ? source.with({
          scheme: container.scheme,
          authority: container.authority,
        })
      : source;
  }

  private async refresh(source: MaterializedSource): Promise<void> {
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === source.source.toString(),
    );
    if (openDocument?.isDirty === true) {
      return;
    }

    const content = await this.fileSystemProvider.readFile(source.virtualSource);
    const parent = source.source.with({
      path: path.posix.dirname(source.source.path),
    });
    await vscode.workspace.fs.createDirectory(parent);

    const currentContent = await tryReadFile(source.source);
    if (currentContent === undefined || !bytesEqual(currentContent, content)) {
      await vscode.workspace.fs.writeFile(source.source, content);
    }
  }

  private async synchronizeDocument(
    document: vscode.TextDocument,
  ): Promise<void> {
    const source = this.sourcesByUri.get(document.uri.toString());
    if (source === undefined) {
      return;
    }
    await this.fileSystemProvider.writeFile(
      source.virtualSource,
      Buffer.from(document.getText(), 'utf8'),
      { create: true, overwrite: true },
    );
  }

  private async synchronizePhysicalFile(
    source: MaterializedSource,
  ): Promise<void> {
    const content = await vscode.workspace.fs.readFile(source.source);
    await this.fileSystemProvider.writeFile(
      source.virtualSource,
      content,
      { create: true, overwrite: true },
    );
  }

  private async persistState(): Promise<void> {
    const snapshot = Object.fromEntries(
      [...this.sourcesByUri].map(([sourceUri, source]) => [
        sourceUri,
        source.container.toString(),
      ]),
    );
    const persistence = this.statePersistence
      .catch(() => undefined)
      .then(() => this.state.update(MATERIALIZED_SOURCES_STATE_KEY, snapshot));
    this.statePersistence = persistence;
    await persistence;
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.sourcesByContainer.clear();
    this.sourcesByUri.clear();
    this.sourcesByVirtualUri.clear();
    this.willSaveVersions.clear();
  }
}

async function tryReadFile(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === 'FileNotFound'
    ) {
      return undefined;
    }
    throw error;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function asSynchronizationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `The temporary Python file was saved, but the LLSP3 project was not updated. ${message}`,
  );
}
