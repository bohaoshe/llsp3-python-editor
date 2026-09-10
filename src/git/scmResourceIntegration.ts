import { existsSync } from 'node:fs';
import * as vscode from 'vscode';

interface InternalGitExtension {
  readonly model?: InternalGitModel;
  getAPI(version: 1): {
    readonly git: {
      readonly path: string;
    };
  };
}

interface InternalGitModel {
  readonly repositories: readonly InternalRepository[];
  readonly onDidOpenRepository: vscode.Event<InternalRepository>;
  readonly onDidCloseRepository: vscode.Event<InternalRepository>;
}

interface InternalRepository {
  readonly root: string;
  readonly mergeGroup: InternalResourceGroup;
  readonly indexGroup: InternalResourceGroup;
  readonly workingTreeGroup: InternalResourceGroup;
  readonly untrackedGroup: InternalResourceGroup;
  readonly onDidRunGitStatus: vscode.Event<void>;
}

interface InternalResourceGroup {
  resourceStates: InternalResource[];
}

interface InternalResource extends vscode.SourceControlResourceState {
  readonly resourceUri: vscode.Uri;
  readonly original?: vscode.Uri;
  readonly type?: number;
}

const RESOURCE_GROUPS = [
  {
    name: 'indexGroup',
    comparison: 'staged',
  },
  {
    name: 'workingTreeGroup',
    comparison: 'unstaged',
  },
  {
    name: 'untrackedGroup',
    comparison: 'unstaged',
  },
] as const;
const originalResources = new WeakMap<
  InternalResource,
  InternalResource
>();
const DELETED_RESOURCE_TYPES = new Set([
  2, // INDEX_DELETED
  6, // DELETED
  14, // DELETED_BY_US
  15, // DELETED_BY_THEM
  17, // BOTH_DELETED
]);

export interface GitScmResourceIntegration {
  readonly disposable: vscode.Disposable;
  readonly gitExecutablePath: string | undefined;
}

export interface ScmComparisonRequest {
  readonly resource: vscode.Uri;
  readonly baselineResource: vscode.Uri;
  readonly repositoryRoot?: string;
}

export async function registerGitScmResourceIntegration(
  isLlsp3Resource: (uri: vscode.Uri) => boolean,
): Promise<GitScmResourceIntegration> {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (extension === undefined) {
    return {
      disposable: new vscode.Disposable(() => undefined),
      gitExecutablePath: undefined,
    };
  }

  let gitExtension: InternalGitExtension;
  try {
    gitExtension = (await extension.activate()) as InternalGitExtension;
  } catch {
    return {
      disposable: new vscode.Disposable(() => undefined),
      gitExecutablePath: undefined,
    };
  }

  let gitExecutablePath: string | undefined;
  try {
    gitExecutablePath = gitExtension.getAPI(1).git.path;
  } catch {
    gitExecutablePath = undefined;
  }
  const model = gitExtension.model;
  if (model === undefined) {
    return {
      disposable: new vscode.Disposable(() => undefined),
      gitExecutablePath,
    };
  }

  const repositorySubscriptions = new Map<
    InternalRepository,
    vscode.Disposable
  >();

  const patchRepository = (repository: InternalRepository): void => {
    for (const group of RESOURCE_GROUPS) {
      patchGitResourceGroup(
        repository[group.name],
        group.comparison,
        isLlsp3Resource,
        repository.root,
      );
    }
  };

  const attachRepository = (repository: InternalRepository): void => {
    if (repositorySubscriptions.has(repository)) {
      return;
    }
    patchRepository(repository);
    repositorySubscriptions.set(
      repository,
      repository.onDidRunGitStatus(() => patchRepository(repository)),
    );
  };

  const detachRepository = (repository: InternalRepository): void => {
    repositorySubscriptions.get(repository)?.dispose();
    repositorySubscriptions.delete(repository);
  };

  for (const repository of model.repositories) {
    attachRepository(repository);
  }

  const openSubscription = model.onDidOpenRepository(attachRepository);
  const closeSubscription = model.onDidCloseRepository(detachRepository);

  return {
    gitExecutablePath,
    disposable: new vscode.Disposable(() => {
      openSubscription.dispose();
      closeSubscription.dispose();
      for (const [repository, subscription] of repositorySubscriptions) {
        subscription.dispose();
        unpatchRepository(repository);
      }
      repositorySubscriptions.clear();
    }),
  };
}

export function patchGitResourceGroup(
  group: InternalResourceGroup,
  comparison: 'staged' | 'unstaged',
  isLlsp3Resource: (uri: vscode.Uri) => boolean,
  repositoryRoot?: string,
): void {
  let changed = false;
  const resources = group.resourceStates.map((resource) => {
    if (originalResources.has(resource)) {
      return resource;
    }

    const baselineResource = resource.original ?? resource.resourceUri;
    if (
      !isLlsp3Resource(resource.resourceUri) ||
      !isLlsp3Resource(baselineResource) ||
      (resource.type !== undefined &&
        DELETED_RESOURCE_TYPES.has(resource.type)) ||
      (comparison === 'unstaged' &&
        !existsSync(resource.resourceUri.fsPath))
    ) {
      return resource;
    }

    const patchedResource = Object.create(resource) as InternalResource;
    Object.defineProperty(patchedResource, 'command', {
      configurable: true,
      enumerable: true,
      get: () => ({
        command:
          comparison === 'staged'
            ? 'llsp3.compareStagedWithRemote'
            : 'llsp3.compareWorkingTreeWithIndex',
        title: 'Open LLSP3 Python Diff',
        arguments: [
          {
            resource: resource.resourceUri,
            baselineResource,
            ...(repositoryRoot === undefined
              ? {}
              : { repositoryRoot }),
          } satisfies ScmComparisonRequest,
        ],
      }),
    });
    originalResources.set(patchedResource, resource);
    changed = true;
    return patchedResource;
  });

  if (changed) {
    group.resourceStates = resources;
  }
}

function unpatchRepository(repository: InternalRepository): void {
  for (const groupDefinition of RESOURCE_GROUPS) {
    const group = repository[groupDefinition.name];
    let changed = false;
    const resources = group.resourceStates.map((resource) => {
      const original = originalResources.get(resource);
      if (original !== undefined) {
        originalResources.delete(resource);
        changed = true;
        return original;
      }
      return resource;
    });
    if (changed) {
      group.resourceStates = resources;
    }
  }
}
