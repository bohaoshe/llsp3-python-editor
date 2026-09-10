import { createHash } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import * as vscode from 'vscode';
import {
  Llsp3Error,
  readLlsp3Project,
  updateLlsp3Source,
} from './archive';
import {
  ConditionalFileReplaceError,
  replaceFileConditionally,
} from './conditionalFileReplace';
import { getContainerUri } from './uri';

interface SourceBaseline {
  readonly archiveHash: string;
  readonly sourceHash: string;
}

const BASELINE_STATE_KEY = 'llsp3.sourceBaselines';

export class Llsp3FileSystemProvider
  implements vscode.FileSystemProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  private readonly baselines = new Map<string, SourceBaseline>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private baselinePersistence: Promise<void> = Promise.resolve();

  public readonly onDidChangeFile = this.changeEmitter.event;

  public constructor(private readonly state: vscode.Memento) {
    const storedBaselines = state.get<Record<string, SourceBaseline>>(
      BASELINE_STATE_KEY,
      {},
    );
    for (const [key, baseline] of Object.entries(storedBaselines)) {
      if (
        typeof baseline.archiveHash === 'string' &&
        typeof baseline.sourceHash === 'string'
      ) {
        this.baselines.set(key, baseline);
      }
    }
  }

  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const container = getContainerUri(uri);
    const containerStat = await vscode.workspace.fs.stat(container);

    return {
      type: vscode.FileType.File,
      ctime: containerStat.ctime,
      mtime: containerStat.mtime,
      size: containerStat.size,
    };
  }

  public watch(uri: vscode.Uri): vscode.Disposable {
    const container = getContainerUri(uri);
    const parent = container.with({
      path: path.posix.dirname(container.path),
      query: '',
      fragment: '',
    });
    const pattern = new vscode.RelativePattern(
      parent,
      path.posix.basename(container.path),
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const subscriptions = [
      watcher.onDidCreate(() => {
        this.changeEmitter.fire([
          { type: vscode.FileChangeType.Created, uri },
        ]);
      }),
      watcher.onDidChange(() => {
        this.changeEmitter.fire([
          { type: vscode.FileChangeType.Changed, uri },
        ]);
      }),
      watcher.onDidDelete(() => {
        this.changeEmitter.fire([
          { type: vscode.FileChangeType.Deleted, uri },
        ]);
      }),
      watcher,
    ];

    return vscode.Disposable.from(...subscriptions);
  }

  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const archive = await vscode.workspace.fs.readFile(getContainerUri(uri));
    const project = readProjectForProvider(archive);
    const sourceKey = uri.toString();
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === sourceKey,
    );
    if (openDocument?.isDirty !== true) {
      await this.setBaseline(
        sourceKey,
        hashArchive(archive),
        hashSource(project.source),
      );
    }
    return Buffer.from(project.source, 'utf8');
  }

  public async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    if (!options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }

    const container = getContainerUri(uri);
    const queueKey = container.toString();
    const previousWrite = this.writeQueues.get(queueKey) ?? Promise.resolve();
    const queuedWrite = previousWrite
      .catch(() => undefined)
      .then(() => this.performWrite(uri, container, content));
    this.writeQueues.set(queueKey, queuedWrite);

    try {
      await queuedWrite;
    } finally {
      if (this.writeQueues.get(queueKey) === queuedWrite) {
        this.writeQueues.delete(queueKey);
      }
    }
  }

  private async performWrite(
    uri: vscode.Uri,
    container: vscode.Uri,
    content: Uint8Array,
  ): Promise<void> {
    const latestArchive = await vscode.workspace.fs.readFile(container);
    const latestProject = readProjectForProvider(latestArchive);
    const source = decodeSource(content);
    const baseline = this.baselines.get(uri.toString());
    const latestHash = hashArchive(latestArchive);
    const latestSourceHash = hashSource(latestProject.source);

    if (
      baseline !== undefined &&
      baseline.archiveHash !== latestHash &&
      baseline.sourceHash !== latestSourceHash &&
      source !== latestProject.source
    ) {
      throw vscode.FileSystemError.Unavailable(
        'The embedded Python source changed outside this editor. Reopen the project or compare it before saving.',
      );
    }

    if (baseline === undefined && source !== latestProject.source) {
      throw vscode.FileSystemError.Unavailable(
        'VS Code restored this edited document without its LLSP3 base version, so the extension cannot safely overwrite the archive. Copy the Python changes, reopen the project, and apply them again.',
      );
    }

    if (source === latestProject.source) {
      await this.setBaseline(
        uri.toString(),
        latestHash,
        latestSourceHash,
      );
      return;
    }

    let updatedArchive: Uint8Array;
    try {
      updatedArchive = updateLlsp3Source(latestArchive, source);
    } catch (error) {
      throw asProviderError(error);
    }
    await writeSafely(container, updatedArchive, latestHash);
    await this.setBaseline(
      uri.toString(),
      hashArchive(updatedArchive),
      hashSource(source),
    );
    this.changeEmitter.fire([
      { type: vscode.FileChangeType.Changed, uri },
    ]);
  }

  private async setBaseline(
    key: string,
    archiveHash: string,
    sourceHash: string,
  ): Promise<void> {
    this.baselines.set(key, { archiveHash, sourceHash });
    const snapshot = Object.fromEntries(this.baselines);
    const persistence = this.baselinePersistence
      .catch(() => undefined)
      .then(() => this.state.update(BASELINE_STATE_KEY, snapshot));
    this.baselinePersistence = persistence;
    await persistence;
  }

  public readDirectory(): never {
    throw vscode.FileSystemError.NoPermissions(
      'LLSP3 virtual documents do not expose directories.',
    );
  }

  public createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions(
      'LLSP3 virtual documents do not expose directories.',
    );
  }

  public delete(): never {
    throw vscode.FileSystemError.NoPermissions(
      'Delete the containing .llsp3 file instead.',
    );
  }

  public rename(): never {
    throw vscode.FileSystemError.NoPermissions(
      'Rename the containing .llsp3 file instead.',
    );
  }

  public dispose(): void {
    this.baselines.clear();
    this.writeQueues.clear();
    this.changeEmitter.dispose();
  }
}

async function writeSafely(
  container: vscode.Uri,
  content: Uint8Array,
  expectedHash: string,
): Promise<void> {
  if (!isDiskBackedWorkspaceUri(container)) {
    throw vscode.FileSystemError.NoPermissions(
      `Safe LLSP3 saves require a disk-backed workspace, but this file uses the "${container.scheme}" URI scheme.`,
    );
  }

  try {
    await replaceFileConditionally(container.fsPath, content, expectedHash);
  } catch (error) {
    if (error instanceof ConditionalFileReplaceError) {
      throw vscode.FileSystemError.Unavailable(error.message);
    }
    throw error;
  }
}

function isDiskBackedWorkspaceUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'vscode-remote';
}

function decodeSource(content: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw vscode.FileSystemError.Unavailable(
      `The Python document is not valid UTF-8: ${message}`,
    );
  }
}

function hashArchive(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function hashSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function readProjectForProvider(content: Uint8Array) {
  try {
    return readLlsp3Project(content);
  } catch (error) {
    throw asProviderError(error);
  }
}

function asProviderError(error: unknown): unknown {
  if (error instanceof Llsp3Error) {
    return vscode.FileSystemError.Unavailable(error.message);
  }
  return error;
}
