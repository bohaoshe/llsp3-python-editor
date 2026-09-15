import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { GitRevisionContentProvider, LLSP3_GIT_SCHEME } from './git/revisionContentProvider';
import {
  configureGitDiff,
  GitCommandError,
  readComparisonBase,
  readStagedComparison,
  readUnstagedComparisonBase,
  setGitExecutablePath,
} from './git/gitSupport';
import {
  registerGitScmResourceIntegration,
  type ScmComparisonRequest,
} from './git/scmResourceIntegration';
import { Llsp3Error, readLlsp3Project } from './llsp3/archive';
import { Llsp3FileSystemProvider } from './llsp3/fileSystemProvider';
import { Llsp3MaterializedSourceManager } from './llsp3/materializedSource';
import { Llsp3ProjectEditor } from './llsp3/projectEditor';
import {
  getContainerUri,
  isLlsp3Container,
  LLSP3_SOURCE_SCHEME,
} from './llsp3/uri';

const PROJECT_EDITOR_VIEW_TYPE = 'llsp3.projectEditor';
type ComparisonMode = 'default' | 'staged' | 'unstaged';

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const fileSystemProvider = new Llsp3FileSystemProvider(
    context.workspaceState,
  );
  const revisionProvider = new GitRevisionContentProvider();
  const reportError = (error: unknown): void => {
    void vscode.window.showErrorMessage(formatError(error));
  };
  const materializedSources = new Llsp3MaterializedSourceManager(
    vscode.Uri.file(path.join(tmpdir(), 'llsp3-python-editor')),
    context.workspaceState,
    fileSystemProvider,
    reportError,
  );
  const updateMaterializedSourceContext = async (
    editor: vscode.TextEditor | undefined,
  ): Promise<void> => {
    await vscode.commands.executeCommand(
      'setContext',
      'llsp3.materializedSourceActive',
      editor !== undefined &&
        materializedSources.getContainer(editor.document.uri) !== undefined,
    );
  };
  await updateMaterializedSourceContext(vscode.window.activeTextEditor);

  const openSource = async (
    container: vscode.Uri,
    viewColumn?: vscode.ViewColumn,
  ): Promise<void> => {
    const workingContainer =
      normalizeContainer(container, materializedSources) ?? container;
    const sourceUri = await materializedSources.open(workingContainer);
    const document = await vscode.workspace.openTextDocument(sourceUri);

    const showOptions: vscode.TextDocumentShowOptions = {
      preview: false,
      preserveFocus: false,
    };
    if (viewColumn !== undefined) {
      showOptions.viewColumn = viewColumn;
    }
    await vscode.window.showTextDocument(document, showOptions);
  };

  const openGitComparison = async (
    container: vscode.Uri,
    mode: ComparisonMode = 'default',
    requestedOptions?: vscode.TextDocumentShowOptions,
    pathOptions: {
      readonly baselineResource?: vscode.Uri;
      readonly repositoryRoot?: string;
    } = {},
  ): Promise<void> => {
    const workingContainer =
      normalizeContainer(container, materializedSources) ?? container;
    requireTrustedWorkspaceForGit();
    const stagedComparison =
      mode === 'staged'
        ? await readStagedComparison(workingContainer, pathOptions)
        : undefined;
    const comparisonBase =
      stagedComparison?.base ??
      (mode === 'unstaged'
        ? await readUnstagedComparisonBase(
            workingContainer,
            pathOptions,
          )
        : await readComparisonBase(workingContainer));
    const baselineSource =
      comparisonBase.archive === undefined
        ? ''
        : readLlsp3Project(comparisonBase.archive).source;
    const leftUri = revisionProvider.create(
      workingContainer,
      comparisonBase.label,
      baselineSource,
    );
    const rightLabel =
      stagedComparison === undefined
        ? 'NEW - Working Tree'
        : 'NEW - Staged Index';
    const rightUri =
      stagedComparison === undefined
        ? await materializedSources.open(workingContainer)
        : revisionProvider.create(
            workingContainer,
            rightLabel,
            readLlsp3Project(stagedComparison.stagedArchive).source,
          );

    const leftDocument = await vscode.workspace.openTextDocument(leftUri);
    const rightDocument = await vscode.workspace.openTextDocument(rightUri);

    const projectName = path.posix.basename(workingContainer.path);
    const diffOptions: vscode.TextDocumentShowOptions = {
      ...requestedOptions,
      preview: false,
      preserveFocus: false,
    };
    await vscode.commands.executeCommand(
      'vscode.diff',
      leftDocument.uri,
      rightDocument.uri,
      `${projectName} — ${comparisonBase.label} ↔ ${rightLabel}`,
      diffOptions,
    );
    await preferSideBySideDiff(rightDocument.uri);
    await vscode.commands.executeCommand(
      'workbench.action.compareEditor.focusPrimarySide',
      rightDocument.uri,
    );
    if (comparisonBase.warning !== undefined) {
      await vscode.window.showWarningMessage(comparisonBase.warning);
    }
  };

  const projectEditor = new Llsp3ProjectEditor({
    openSource,
    compareWithHead: (container, viewColumn) =>
      openGitComparison(
        container,
        'default',
        viewColumn === undefined ? undefined : { viewColumn },
      ),
    reportError,
  });
  const scmResourceIntegration =
    await registerGitScmResourceIntegration(
      (resource) =>
        normalizeContainer(resource, materializedSources) !== undefined,
    );
  setGitExecutablePath(scmResourceIntegration.gitExecutablePath);

  context.subscriptions.push(
    scmResourceIntegration.disposable,
    materializedSources,
    fileSystemProvider,
    revisionProvider,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void updateMaterializedSourceContext(editor);
    }),
    vscode.workspace.registerFileSystemProvider(
      LLSP3_SOURCE_SCHEME,
      fileSystemProvider,
      {
        isCaseSensitive: true,
        isReadonly: false,
      },
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      LLSP3_GIT_SCHEME,
      revisionProvider,
    ),
    vscode.window.registerCustomEditorProvider(
      PROJECT_EDITOR_VIEW_TYPE,
      projectEditor,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: {
          retainContextWhenHidden: false,
        },
      },
    ),
    vscode.commands.registerCommand(
      'llsp3.openPython',
      async (resource?: vscode.Uri) => {
        try {
          const container = await resolveContainer(
            resource,
            true,
            materializedSources,
          );
          if (container !== undefined) {
            await openSource(container);
          }
        } catch (error) {
          reportError(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      'llsp3.compareWithHead',
      async (resource?: vscode.Uri) => {
        try {
          const container = await resolveContainer(
            resource,
            true,
            materializedSources,
          );
          if (container !== undefined) {
            await openGitComparison(container);
          }
        } catch (error) {
          reportError(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      'llsp3.compareStagedWithRemote',
      async (input?: vscode.Uri | ScmComparisonRequest) => {
        try {
          const request = normalizeScmComparisonRequest(input);
          const container = await resolveContainer(
            request.resource,
            false,
            materializedSources,
          );
          if (container !== undefined) {
            await openGitComparison(
              container,
              'staged',
              undefined,
              request,
            );
          }
        } catch (error) {
          reportError(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      'llsp3.compareWorkingTreeWithIndex',
      async (input?: vscode.Uri | ScmComparisonRequest) => {
        try {
          const request = normalizeScmComparisonRequest(input);
          const container = await resolveContainer(
            request.resource,
            false,
            materializedSources,
          );
          if (container !== undefined) {
            await openGitComparison(
              container,
              'unstaged',
              undefined,
              request,
            );
          }
        } catch (error) {
          reportError(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      'llsp3.configureGitDiff',
      async (resource?: vscode.Uri) => {
        try {
          if (!vscode.workspace.isTrusted) {
            requireTrustedWorkspaceForGit();
          }

          const gitResource = await resolveGitResource(
            resource,
            materializedSources,
          );
          if (gitResource === undefined) {
            return;
          }

          const selection = await vscode.window.showInformationMessage(
            'Configure readable LLSP3 Git diffs? This updates .gitattributes and local Git config, and installs a helper in the private Git directory.',
            { modal: true },
            'Configure',
          );
          if (selection !== 'Configure') {
            return;
          }

          const result = await configureGitDiff(
            gitResource,
            context.extensionPath,
          );
          const attributesNote = result.attributesChanged
            ? ' .gitattributes is now modified and can be committed.'
            : '';
          await vscode.window.showInformationMessage(
            `LLSP3 Git diffs are configured for ${result.repositoryRoot}.${attributesNote}`,
          );
        } catch (error) {
          reportError(error);
        }
      },
    ),
  );

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'llsp3.test.openComparison',
        (
          container: vscode.Uri,
          mode?: ComparisonMode,
        ) => openGitComparison(container, mode),
      ),
    );
  }
}

async function resolveContainer(
  resource: vscode.Uri | undefined,
  showPicker: boolean,
  materializedSources: Llsp3MaterializedSourceManager,
): Promise<vscode.Uri | undefined> {
  const explicit = normalizeContainer(resource, materializedSources);
  if (explicit !== undefined) {
    return explicit;
  }

  const active = normalizeContainer(
    vscode.window.activeTextEditor?.document.uri,
    materializedSources,
  );
  if (active !== undefined) {
    return active;
  }

  if (!showPicker) {
    return undefined;
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      'LLSP3 projects': ['llsp3'],
    },
    title: 'Open LLSP3 Python project',
  });
  return selected?.[0];
}

async function resolveGitResource(
  resource: vscode.Uri | undefined,
  materializedSources: Llsp3MaterializedSourceManager,
): Promise<vscode.Uri | undefined> {
  const container = normalizeContainer(resource, materializedSources);
  if (container !== undefined) {
    return container;
  }

  const active = normalizeContainer(
    vscode.window.activeTextEditor?.document.uri,
    materializedSources,
  );
  if (active !== undefined) {
    return active;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function normalizeContainer(
  resource: vscode.Uri | undefined,
  materializedSources: Llsp3MaterializedSourceManager,
): vscode.Uri | undefined {
  if (resource === undefined) {
    return undefined;
  }
  const materializedContainer = materializedSources.getContainer(resource);
  if (materializedContainer !== undefined) {
    return materializedContainer;
  }
  if (resource.scheme === LLSP3_SOURCE_SCHEME) {
    const container = getContainerUri(resource);
    return normalizeContainer(container, materializedSources) ?? container;
  }
  if (!isLlsp3Container(resource)) {
    return undefined;
  }

  if (resource.scheme === 'file' || resource.scheme === 'vscode-remote') {
    return resource;
  }

  const workspaceResource = findWorkingTreeResource(resource.fsPath);
  if (workspaceResource !== undefined) {
    return workspaceResource;
  }

  return path.isAbsolute(resource.fsPath)
    ? vscode.Uri.file(resource.fsPath)
    : resource;
}

function normalizeScmComparisonRequest(
  input: vscode.Uri | ScmComparisonRequest | undefined,
): ScmComparisonRequest {
  if (input === undefined || isUri(input)) {
    if (input === undefined) {
      throw new Error('The Source Control item did not provide a file.');
    }
    return {
      resource: input,
      baselineResource: input,
    };
  }

  return input;
}

function isUri(value: unknown): value is vscode.Uri {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scheme' in value &&
    'path' in value &&
    typeof value.scheme === 'string' &&
    typeof value.path === 'string'
  );
}

function formatError(error: unknown): string {
  if (error instanceof Llsp3Error) {
    return error.message;
  }
  if (error instanceof GitCommandError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function requireTrustedWorkspaceForGit(): void {
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      'Trust this workspace before running repository Git commands.',
    );
  }
}

async function preferSideBySideDiff(
  modifiedResource: vscode.Uri,
): Promise<void> {
  const commands = new Set(await vscode.commands.getCommands(true));
  if (commands.has('diffEditor.setViewMode.sideBySide')) {
    await vscode.commands.executeCommand(
      'diffEditor.setViewMode.sideBySide',
      modifiedResource,
    );
    return;
  }

  const configuration = vscode.workspace.getConfiguration(
    'diffEditor',
    modifiedResource,
  );
  if (
    configuration.get<boolean>('renderSideBySide', true) === false &&
    commands.has('toggle.diff.renderSideBySide')
  ) {
    await vscode.commands.executeCommand(
      'toggle.diff.renderSideBySide',
      modifiedResource,
    );
  }
}

function findWorkingTreeResource(
  fileSystemPath: string,
): vscode.Uri | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const relativePath = path.relative(folder.uri.fsPath, fileSystemPath);
    if (
      relativePath.length === 0 ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      continue;
    }

    return vscode.Uri.joinPath(
      folder.uri,
      ...relativePath.split(path.sep),
    );
  }
  return undefined;
}
