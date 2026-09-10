import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';

export class GitCommandError extends Error {
  public constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export interface GitDiffConfigurationResult {
  readonly repositoryRoot: string;
  readonly attributesChanged: boolean;
}

export interface GitComparisonBase {
  readonly archive: Uint8Array | undefined;
  readonly label: string;
  readonly warning?: string;
}

export interface GitComparisonPathOptions {
  readonly baselineResource?: vscode.Uri;
  readonly repositoryRoot?: string;
}

let gitExecutablePath = 'git';

export function setGitExecutablePath(executablePath: string | undefined): void {
  const normalized = executablePath?.trim();
  gitExecutablePath =
    normalized === undefined || normalized.length === 0
      ? 'git'
      : normalized;
}

export async function readComparisonBase(
  resource: vscode.Uri,
): Promise<GitComparisonBase> {
  const { repositoryRoot, relativePath } =
    await resolveRepositoryPath(resource);
  return readDefaultComparisonBase(repositoryRoot, relativePath);
}

export async function readStagedComparison(
  resource: vscode.Uri,
  options: GitComparisonPathOptions = {},
): Promise<{
  readonly base: GitComparisonBase;
  readonly stagedArchive: Uint8Array;
}> {
  const { repositoryRoot, relativePath } =
    await resolveRepositoryPath(resource, options);
  const baselineRelativePath = getRepositoryRelativePath(
    repositoryRoot,
    options.baselineResource ?? resource,
  );
  const stagedArchive = await readIndexPath(
    repositoryRoot,
    relativePath,
  );
  if (stagedArchive === undefined) {
    throw new GitCommandError(
      'The staged LLSP3 version is no longer present in the Git index.',
      '',
    );
  }

  return {
    base: await readRemoteComparisonBase(
      repositoryRoot,
      baselineRelativePath,
    ),
    stagedArchive,
  };
}

export async function readUnstagedComparisonBase(
  resource: vscode.Uri,
  options: GitComparisonPathOptions = {},
): Promise<GitComparisonBase> {
  const { repositoryRoot, relativePath } =
    await resolveRepositoryPath(resource, options);
  const baselineRelativePath = getRepositoryRelativePath(
    repositoryRoot,
    options.baselineResource ?? resource,
  );
  let stagedArchive = await readIndexPath(
    repositoryRoot,
    relativePath,
  );
  if (
    stagedArchive === undefined &&
    baselineRelativePath !== relativePath
  ) {
    stagedArchive = await readIndexPath(
      repositoryRoot,
      baselineRelativePath,
    );
  }
  if (stagedArchive !== undefined) {
    return {
      archive: stagedArchive,
      label: 'OLD - Staged Index',
    };
  }

  return readDefaultComparisonBase(
    repositoryRoot,
    baselineRelativePath,
  );
}

async function resolveRepositoryPath(
  resource: vscode.Uri,
  options: GitComparisonPathOptions = {},
): Promise<{
  readonly repositoryRoot: string;
  readonly relativePath: string;
}> {
  const repositoryRoot =
    options.repositoryRoot === undefined
      ? await findRepositoryRoot(resource)
      : path.resolve(options.repositoryRoot);
  return {
    repositoryRoot,
    relativePath: getRepositoryRelativePath(repositoryRoot, resource),
  };
}

async function readDefaultComparisonBase(
  repositoryRoot: string,
  relativePath: string,
): Promise<GitComparisonBase> {
  const localArchive = await readPathAtRevision(
    repositoryRoot,
    relativePath,
    'HEAD',
  );

  if (localArchive !== undefined) {
    return {
      archive: localArchive,
      label: 'OLD - Local HEAD',
    };
  }

  const remoteRevision = await getPreferredRemoteRevision(repositoryRoot);
  if (remoteRevision !== undefined) {
    return {
      archive: await readPathAtRevision(
        repositoryRoot,
        relativePath,
        remoteRevision,
      ),
      label: `OLD - ${remoteRevision}`,
    };
  }

  return {
    archive: undefined,
    label: 'OLD - empty new file',
  };
}

async function readRemoteComparisonBase(
  repositoryRoot: string,
  relativePath: string,
): Promise<GitComparisonBase> {
  let fetchError: GitCommandError | undefined;
  try {
    await runGit(repositoryRoot, ['fetch', '--quiet']);
  } catch (error) {
    if (error instanceof GitCommandError) {
      fetchError = error;
    } else {
      throw error;
    }
  }

  const remoteRevision = await getPreferredRemoteRevision(repositoryRoot);
  if (remoteRevision !== undefined) {
    const result: GitComparisonBase = {
      archive: await readPathAtRevision(
        repositoryRoot,
        relativePath,
        remoteRevision,
      ),
      label: `OLD - Remote ${remoteRevision}`,
    };
    if (fetchError !== undefined) {
      return {
        ...result,
        warning:
          `Remote refresh failed, so the cached ${remoteRevision} version was used: ${fetchError.message}`,
      };
    }
    return result;
  }

  if (fetchError !== undefined) {
    throw new GitCommandError(
      `The remote baseline could not be refreshed and no cached remote version of this file exists: ${fetchError.message}`,
      fetchError.stderr,
    );
  }

  return {
    archive: undefined,
    label: 'OLD - empty remote file',
  };
}

async function readIndexPath(
  repositoryRoot: string,
  relativePath: string,
): Promise<Uint8Array | undefined> {
  const indexEntry = await runGit(repositoryRoot, [
    'ls-files',
    '--stage',
    '--',
    relativePath,
  ]);
  if (indexEntry.byteLength === 0) {
    return undefined;
  }
  return runGit(repositoryRoot, ['show', `:${relativePath}`]);
}

function getRepositoryRelativePath(
  repositoryRoot: string,
  resource: vscode.Uri,
): string {
  const relativePath = path
    .relative(repositoryRoot, resource.fsPath)
    .replaceAll(path.sep, '/');
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith('../')
  ) {
    throw new GitCommandError(
      'The LLSP3 file is not inside the selected Git repository.',
      '',
    );
  }
  return relativePath;
}

async function readPathAtRevision(
  repositoryRoot: string,
  relativePath: string,
  revision: string,
): Promise<Uint8Array | undefined> {
  try {
    await runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${revision}^{commit}`,
    ]);
  } catch (error) {
    if (error instanceof GitCommandError && error.stderr.length === 0) {
      return undefined;
    }
    throw error;
  }

  const treeEntry = await runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    revision,
    '--',
    relativePath,
  ]);
  if (treeEntry.byteLength === 0) {
    return undefined;
  }

  return runGit(repositoryRoot, ['show', `${revision}:${relativePath}`]);
}

async function getRemoteRevisionCandidates(
  repositoryRoot: string,
): Promise<string[]> {
  const candidates: string[] = [];
  const upstream = await tryRunGitText(repositoryRoot, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  addRevisionCandidate(candidates, upstream);

  const branch = await tryRunGitText(repositoryRoot, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const remotesText = await tryRunGitText(repositoryRoot, ['remote']);
  const remotes =
    remotesText === undefined
      ? []
      : remotesText
          .split(/\r?\n/u)
          .map((remote) => remote.trim())
          .filter((remote) => remote.length > 0);

  if (branch !== undefined) {
    for (const remote of remotes) {
      addRevisionCandidate(candidates, `${remote}/${branch}`);
    }
  }

  for (const remote of remotes) {
    const remoteHead = await tryRunGitText(repositoryRoot, [
      'symbolic-ref',
      '--quiet',
      '--short',
      `refs/remotes/${remote}/HEAD`,
    ]);
    addRevisionCandidate(candidates, remoteHead);
  }

  return candidates;
}

async function getPreferredRemoteRevision(
  repositoryRoot: string,
): Promise<string | undefined> {
  for (const candidate of await getRemoteRevisionCandidates(
    repositoryRoot,
  )) {
    if (await revisionExists(repositoryRoot, candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function revisionExists(
  repositoryRoot: string,
  revision: string,
): Promise<boolean> {
  try {
    await runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${revision}^{commit}`,
    ]);
    return true;
  } catch (error) {
    if (error instanceof GitCommandError) {
      return false;
    }
    throw error;
  }
}

function addRevisionCandidate(
  candidates: string[],
  revision: string | undefined,
): void {
  const normalized = revision?.trim();
  if (
    normalized !== undefined &&
    normalized.length > 0 &&
    !candidates.includes(normalized)
  ) {
    candidates.push(normalized);
  }
}

export async function configureGitDiff(
  resource: vscode.Uri,
  extensionPath: string,
): Promise<GitDiffConfigurationResult> {
  const repositoryRoot = await findRepositoryRoot(resource);
  const commonDirectoryText = await runGitText(repositoryRoot, [
    'rev-parse',
    '--git-common-dir',
  ]);
  const configuredCommonDirectory = commonDirectoryText.trim();
  if (configuredCommonDirectory.length === 0) {
    throw new GitCommandError(
      'Git did not return its common metadata directory.',
      '',
    );
  }

  const commonDirectory = path.isAbsolute(configuredCommonDirectory)
    ? configuredCommonDirectory
    : path.resolve(repositoryRoot, configuredCommonDirectory);
  const helperPath = path.join(commonDirectory, 'llsp3-textconv.cjs');
  await mkdir(path.dirname(helperPath), { recursive: true });
  await copyFile(
    path.join(extensionPath, 'resources', 'llsp3-textconv.cjs'),
    helperPath,
  );

  const helperCommand =
    'node "$(git rev-parse --git-common-dir)/llsp3-textconv.cjs"';
  await runGit(repositoryRoot, [
    'config',
    '--local',
    'diff.llsp3.textconv',
    helperCommand,
  ]);
  await runGit(repositoryRoot, [
    'config',
    '--local',
    'diff.llsp3.cachetextconv',
    'true',
  ]);

  let attributesChanged = await ensureGitAttributes(repositoryRoot, false);
  const probePath = getAttributeProbePath(repositoryRoot, resource);
  let effectiveAttribute = await readEffectiveDiffAttribute(
    repositoryRoot,
    probePath,
  );

  if (effectiveAttribute !== 'llsp3') {
    attributesChanged =
      (await ensureGitAttributes(repositoryRoot, true)) || attributesChanged;
    effectiveAttribute = await readEffectiveDiffAttribute(
      repositoryRoot,
      probePath,
    );
  }

  if (effectiveAttribute !== 'llsp3') {
    throw new GitCommandError(
      `Git's effective diff attribute for "${probePath}" is "${effectiveAttribute}", not "llsp3". A nested .gitattributes or .git/info/attributes rule is overriding the repository setting.`,
      '',
    );
  }

  return { repositoryRoot, attributesChanged };
}

export async function findRepositoryRoot(
  resource: vscode.Uri,
): Promise<string> {
  let resourceStat: Awaited<ReturnType<typeof stat>>;
  try {
    resourceStat = await stat(resource.fsPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitCommandError(
      `Git cannot access the workspace path for URI scheme "${resource.scheme}": ${message}`,
      '',
    );
  }
  const workingDirectory = resourceStat.isDirectory()
    ? resource.fsPath
    : path.dirname(resource.fsPath);
  const output = await runGitText(workingDirectory, [
    'rev-parse',
    '--show-toplevel',
  ]);
  const root = output.trim();

  if (root.length === 0) {
    throw new GitCommandError('Git did not return a repository root.', '');
  }
  return path.resolve(root);
}

async function ensureGitAttributes(
  repositoryRoot: string,
  requireLastRule: boolean,
): Promise<boolean> {
  const attributesPath = path.join(repositoryRoot, '.gitattributes');
  let current = '';

  try {
    current = await readFile(attributesPath, 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const lines = current.split(/\r?\n/u);
  const exactRule = (line: string): boolean => {
    const attributes = line.trim().split(/\s+/u);
    return (
      attributes[0] === '*.llsp3' &&
      attributes.slice(1).includes('diff=llsp3')
    );
  };
  const alreadyConfigured = lines.some(exactRule);
  const lastMeaningfulLine = [...lines].reverse().find((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#');
  });
  const lastRuleIsConfigured =
    lastMeaningfulLine !== undefined && exactRule(lastMeaningfulLine);
  if (
    (!requireLastRule && alreadyConfigured) ||
    (requireLastRule && lastRuleIsConfigured)
  ) {
    return false;
  }

  const endOfLine = current.includes('\r\n') ? '\r\n' : '\n';
  const separator =
    current.length === 0 || current.endsWith('\n') ? '' : endOfLine;
  await writeFile(
    attributesPath,
    `${current}${separator}*.llsp3 diff=llsp3${endOfLine}`,
    'utf8',
  );
  return true;
}

function getAttributeProbePath(
  repositoryRoot: string,
  resource: vscode.Uri,
): string {
  if (
    path.extname(resource.fsPath).toLowerCase() === '.llsp3'
  ) {
    const relativePath = path.relative(repositoryRoot, resource.fsPath);
    if (
      relativePath.length > 0 &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`)
    ) {
      return relativePath.replaceAll(path.sep, '/');
    }
  }
  return '.llsp3-editor-attribute-probe.llsp3';
}

async function readEffectiveDiffAttribute(
  repositoryRoot: string,
  relativePath: string,
): Promise<string> {
  const output = await runGit(repositoryRoot, [
    'check-attr',
    '-z',
    'diff',
    '--',
    relativePath,
  ]);
  const fields = Buffer.from(output).toString('utf8').split('\0');
  const value = fields[2];
  if (value === undefined || value.length === 0) {
    throw new GitCommandError(
      `Git did not return an effective diff attribute for "${relativePath}".`,
      '',
    );
  }
  return value;
}

async function runGitText(
  workingDirectory: string,
  arguments_: readonly string[],
): Promise<string> {
  const output = await runGit(workingDirectory, arguments_);
  return Buffer.from(output).toString('utf8');
}

async function tryRunGitText(
  workingDirectory: string,
  arguments_: readonly string[],
): Promise<string | undefined> {
  try {
    return (await runGitText(workingDirectory, arguments_)).trim();
  } catch (error) {
    if (error instanceof GitCommandError) {
      return undefined;
    }
    throw error;
  }
}

async function runGit(
  workingDirectory: string,
  arguments_: readonly string[],
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      gitExecutablePath,
      ['-C', workingDirectory, ...arguments_],
      {
        cwd: workingDirectory,
        env: createGitEnvironment(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      reject(
        new GitCommandError(`Git could not be started: ${error.message}`, ''),
      );
    });
    child.on('close', (exitCode) => {
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (exitCode !== 0) {
        reject(
          new GitCommandError(
            errorOutput.length > 0
              ? errorOutput
              : `Git exited with code ${exitCode ?? 'unknown'}.`,
            errorOutput,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

function createGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey === 'GIT_CONFIG_COUNT' ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(normalizedKey)
    ) {
      delete environment[key];
    }
  }
  return environment;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
