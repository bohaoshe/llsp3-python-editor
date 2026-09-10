import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { patchGitResourceGroup } from '../../src/git/scmResourceIntegration';
import { readLlsp3Project } from '../../src/llsp3/archive';

suite('LLSP3 editor integration', () => {
  const extensionId = 'bohaoshe.llsp3-python-editor';
  let workspaceFolder: vscode.WorkspaceFolder;

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    workspaceFolder = folder;

    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension);
    await extension.activate();

    const gitExtension = vscode.extensions.getExtension('vscode.git');
    assert.ok(gitExtension);
    const git = (await gitExtension.activate()) as {
      getAPI(version: 1): {
        openRepository(root: vscode.Uri): Promise<unknown>;
      };
    };
    await git.getAPI(1).openRepository(folder.uri);
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('Explorer opens editable embedded Python directly', async () => {
    const project = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'tracked.llsp3',
    );
    await vscode.commands.executeCommand(
      'vscode.openWith',
      project,
      'llsp3.projectEditor',
      { preview: false },
    );

    const tab = await waitForActiveTab(
      (candidate) => candidate.input instanceof vscode.TabInputText,
    );
    assert.ok(tab.input instanceof vscode.TabInputText);
    assert.equal(tab.input.uri.scheme, 'llsp3');
    assert.equal(
      await readDocument(tab.input.uri),
      'print("unstaged working tree")\n',
    );
  });

  test('Staged Changes compare remote to Git index', async () => {
    const project = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'tracked.llsp3',
    );
    await executeLiveScmResourceCommand(project, ['indexGroup']);

    const tab = await waitForActiveTab(
      (candidate) => candidate.input instanceof vscode.TabInputTextDiff,
    );
    assert.ok(tab.input instanceof vscode.TabInputTextDiff);
    assert.equal(tab.input.original.scheme, 'llsp3-git');
    assert.equal(tab.input.modified.scheme, 'llsp3-git');
    assert.equal(
      await readDocument(tab.input.original),
      'print("remote latest")\n',
    );
    assert.equal(
      await readDocument(tab.input.modified),
      'print("staged index")\n',
    );
    assert.match(tab.label, /Remote origin\/main/u);
  });

  test('Changes compare Git index to working tree', async () => {
    const project = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'tracked.llsp3',
    );
    await executeLiveScmResourceCommand(project, ['workingTreeGroup']);

    const tab = await waitForActiveTab(
      (candidate) => candidate.input instanceof vscode.TabInputTextDiff,
    );
    assert.ok(tab.input instanceof vscode.TabInputTextDiff);
    assert.equal(tab.input.original.scheme, 'llsp3-git');
    assert.equal(tab.input.modified.scheme, 'llsp3');
    assert.equal(
      await readDocument(tab.input.original),
      'print("staged index")\n',
    );
    assert.equal(
      await readDocument(tab.input.modified),
      'print("unstaged working tree")\n',
    );

    const modifiedDocument = await vscode.workspace.openTextDocument(
      tab.input.modified,
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      modifiedDocument.uri,
      fullDocumentRange(modifiedDocument),
      'print("saved from diff")\n',
    );
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await modifiedDocument.save(), true);
    const updatedArchive = await vscode.workspace.fs.readFile(project);
    assert.equal(
      readLlsp3Source(updatedArchive),
      'print("saved from diff")\n',
    );
  });

  test('Source Control new file falls back to upstream remote', async () => {
    const project = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'remote-only.llsp3',
    );

    await executeLiveScmResourceCommand(project, [
      'untrackedGroup',
      'workingTreeGroup',
    ]);

    const tab = await waitForActiveTab(
      (candidate) => candidate.input instanceof vscode.TabInputTextDiff,
    );
    assert.ok(tab.input instanceof vscode.TabInputTextDiff);
    assert.equal(
      await readDocument(tab.input.original),
      'print("remote committed")\n',
    );
    assert.equal(
      await readDocument(tab.input.modified),
      'print("local untracked")\n',
    );
    assert.match(tab.label, /origin\/main/u);
  });

  test('Changes after staged rename use destination index version', async () => {
    const project = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'rename-new.llsp3',
    );
    await executeLiveScmResourceCommand(project, ['workingTreeGroup']);

    const tab = await waitForActiveTab(
      (candidate) => candidate.input instanceof vscode.TabInputTextDiff,
    );
    assert.ok(tab.input instanceof vscode.TabInputTextDiff);
    assert.equal(
      await readDocument(tab.input.original),
      'print("rename staged")\n',
    );
    assert.equal(
      await readDocument(tab.input.modified),
      'print("rename unstaged")\n',
    );
  });

  test('Git resource rows are redirected to the LLSP3 diff command', () => {
    const project = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'tracked.llsp3',
    );
    const resource = Object.create({
      get command(): vscode.Command {
        return {
          command: 'vscode.diff',
          title: 'Open Changes',
        };
      },
    }) as vscode.SourceControlResourceState;
    Object.defineProperty(resource, 'resourceUri', {
      enumerable: true,
      value: project,
    });
    Object.defineProperty(resource, 'command', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: {
        command: 'vscode.diff',
        title: 'Cached Open Changes',
      },
    });
    const stagedGroup = { resourceStates: [resource] };

    patchGitResourceGroup(
      stagedGroup,
      'staged',
      (candidate) => candidate.path.endsWith('.llsp3'),
    );

    const stagedResource = stagedGroup.resourceStates[0];
    assert.ok(stagedResource);
    assert.equal(
      stagedResource.command?.command,
      'llsp3.compareStagedWithRemote',
    );
    assert.deepEqual(stagedResource.command?.arguments, [
      {
        resource: project,
        baselineResource: project,
      },
    ]);

    const unstagedResource = Object.create({
      get command(): vscode.Command {
        return {
          command: 'vscode.diff',
          title: 'Open Changes',
        };
      },
    }) as vscode.SourceControlResourceState;
    Object.defineProperty(unstagedResource, 'resourceUri', {
      enumerable: true,
      value: project,
    });
    const unstagedGroup = { resourceStates: [unstagedResource] };
    patchGitResourceGroup(
      unstagedGroup,
      'unstaged',
      (candidate) => candidate.path.endsWith('.llsp3'),
    );
    const patchedUnstagedResource = unstagedGroup.resourceStates[0];
    assert.ok(patchedUnstagedResource);
    assert.equal(
      patchedUnstagedResource.command?.command,
      'llsp3.compareWorkingTreeWithIndex',
    );
  });

  test('Deleted Git resource rows retain the built-in command', () => {
    const existingProject = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'tracked.llsp3',
    );
    const resource = Object.create({
      get command(): vscode.Command {
        return {
          command: 'vscode.diff',
          title: 'Open Changes',
        };
      },
    }) as vscode.SourceControlResourceState;
    Object.defineProperty(resource, 'resourceUri', {
      enumerable: true,
      value: existingProject,
    });
    Object.defineProperty(resource, 'type', {
      enumerable: true,
      value: 2,
    });
    const group = { resourceStates: [resource] };

    patchGitResourceGroup(
      group,
      'staged',
      (candidate) => candidate.path.endsWith('.llsp3'),
    );

    const retainedResource = group.resourceStates[0];
    assert.ok(retainedResource);
    assert.equal(retainedResource.command?.command, 'vscode.diff');
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        retainedResource,
        'command',
      ),
      false,
    );
  });

  test('Staged rows work without a working-tree file', () => {
    const missingProject = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'staged-only.llsp3',
    );
    const resource = createMockGitResource(missingProject, 1);
    const group = { resourceStates: [resource] };

    patchGitResourceGroup(
      group,
      'staged',
      (candidate) => candidate.path.endsWith('.llsp3'),
      workspaceFolder.uri.fsPath,
    );

    assert.equal(
      group.resourceStates[0]?.command?.command,
      'llsp3.compareStagedWithRemote',
    );
  });

  test('Renamed rows carry original and destination paths', () => {
    const original = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'old.llsp3',
    );
    const destination = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'tracked.llsp3',
    );
    const resource = createMockGitResource(destination, 3, original);
    const group = { resourceStates: [resource] };

    patchGitResourceGroup(
      group,
      'staged',
      (candidate) => candidate.path.endsWith('.llsp3'),
      workspaceFolder.uri.fsPath,
    );

    assert.deepEqual(group.resourceStates[0]?.command?.arguments, [
      {
        resource: destination,
        baselineResource: original,
        repositoryRoot: workspaceFolder.uri.fsPath,
      },
    ]);
  });
});

function createMockGitResource(
  resourceUri: vscode.Uri,
  type?: number,
  original?: vscode.Uri,
): vscode.SourceControlResourceState {
  const resource = Object.create({
    get command(): vscode.Command {
      return {
        command: 'vscode.diff',
        title: 'Open Changes',
      };
    },
  }) as vscode.SourceControlResourceState;
  Object.defineProperty(resource, 'resourceUri', {
    enumerable: true,
    value: resourceUri,
  });
  if (type !== undefined) {
    Object.defineProperty(resource, 'type', {
      enumerable: true,
      value: type,
    });
  }
  if (original !== undefined) {
    Object.defineProperty(resource, 'original', {
      enumerable: true,
      value: original,
    });
  }
  return resource;
}

async function executeLiveScmResourceCommand(
  project: vscode.Uri,
  groupNames: readonly (
    | 'indexGroup'
    | 'workingTreeGroup'
    | 'untrackedGroup'
  )[],
): Promise<void> {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  assert.ok(gitExtension);
  const git = (await gitExtension.activate()) as {
    model?: {
      repositories: Array<{
        root: string;
        indexGroup: {
          resourceStates: vscode.SourceControlResourceState[];
        };
        workingTreeGroup: {
          resourceStates: vscode.SourceControlResourceState[];
        };
        untrackedGroup: {
          resourceStates: vscode.SourceControlResourceState[];
        };
      }>;
    };
  };
  const repository = await waitForRepository(
    git,
    workspaceFolderPath(),
  );
  const resource = await waitForResource(
    groupNames.map((groupName) => repository[groupName]),
    project,
  );
  const expectedCommand = groupNames.includes('indexGroup')
    ? 'llsp3.compareStagedWithRemote'
    : 'llsp3.compareWorkingTreeWithIndex';
  assert.equal(resource.command?.command, expectedCommand);
  assert.ok(resource.command);
  await vscode.commands.executeCommand(
    resource.command.command,
    ...(resource.command.arguments ?? []),
  );
}

async function waitForRepository(
  git: {
    model?: {
      repositories: Array<{
        root: string;
        indexGroup: {
          resourceStates: vscode.SourceControlResourceState[];
        };
        workingTreeGroup: {
          resourceStates: vscode.SourceControlResourceState[];
        };
        untrackedGroup: {
          resourceStates: vscode.SourceControlResourceState[];
        };
      }>;
    };
  },
  rootPath: string,
) {
  const deadline = Date.now() + 10_000;
  const normalizedRoot = normalizePath(rootPath);
  while (Date.now() < deadline) {
    const repository = git.model?.repositories.find(
      (candidate) => normalizePath(candidate.root) === normalizedRoot,
    );
    if (repository !== undefined) {
      return repository;
    }
    await delay(50);
  }
  throw new Error(`Git repository was not opened: ${rootPath}`);
}

async function waitForResource(
  groups: Array<{
    resourceStates: vscode.SourceControlResourceState[];
  }>,
  project: vscode.Uri,
): Promise<vscode.SourceControlResourceState> {
  const deadline = Date.now() + 10_000;
  const normalizedProject = normalizePath(project.fsPath);
  while (Date.now() < deadline) {
    const resource = groups
      .flatMap((group) => group.resourceStates)
      .find(
        (candidate) =>
          normalizePath(candidate.resourceUri.fsPath) ===
          normalizedProject,
      );
    if (resource !== undefined) {
      return resource;
    }
    await delay(50);
  }
  throw new Error(`Source Control resource was not found: ${project.fsPath}`);
}

function workspaceFolderPath(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder);
  return folder.uri.fsPath;
}

async function waitForActiveTab(
  predicate: (tab: vscode.Tab) => boolean,
): Promise<vscode.Tab> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (activeTab !== undefined && predicate(activeTab)) {
      return activeTab;
    }
    await delay(50);
  }

  const visibleTabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => `${tab.label}: ${describeInput(tab.input)}`)
    .join(', ');
  throw new Error(`Expected editor tab did not open. Visible tabs: ${visibleTabs}`);
}

async function readDocument(uri: vscode.Uri): Promise<string> {
  return (await vscode.workspace.openTextDocument(uri)).getText();
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = document.lineAt(document.lineCount - 1);
  return new vscode.Range(
    new vscode.Position(0, 0),
    lastLine.rangeIncludingLineBreak.end,
  );
}

function readLlsp3Source(archive: Uint8Array): string {
  return readLlsp3Project(archive).source;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizePath(filePath: string): string {
  return process.platform === 'win32'
    ? filePath.toLowerCase()
    : filePath;
}

function describeInput(input: unknown): string {
  if (
    typeof input === 'object' &&
    input !== null &&
    'constructor' in input &&
    typeof input.constructor === 'function'
  ) {
    return input.constructor.name;
  }
  return typeof input;
}
