import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  link,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { lock } from 'proper-lockfile';

export class ConditionalFileReplaceError extends Error {
  public constructor(
    message: string,
    public readonly recoveryPaths: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConditionalFileReplaceError';
  }
}

export async function replaceFileConditionally(
  targetPath: string,
  content: Uint8Array,
  expectedHash: string,
): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(targetPath, {
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: {
        retries: 20,
        factor: 1.25,
        minTimeout: 10,
        maxTimeout: 100,
      },
    });
  } catch (error) {
    throw replacementError(
      `Another process is already saving this project: ${errorMessage(error)}`,
      [],
      error,
    );
  }

  let operationError: unknown;
  try {
    await replaceFileWhileLocked(targetPath, content, expectedHash);
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown;
  try {
    await release();
  } catch (error) {
    releaseError = error;
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  if (releaseError !== undefined) {
    throw replacementError(
      `The project was saved, but its save lock could not be released: ${errorMessage(releaseError)}`,
      [],
      releaseError,
    );
  }
}

async function replaceFileWhileLocked(
  targetPath: string,
  content: Uint8Array,
  expectedHash: string,
): Promise<void> {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  const backupPath = `${targetPath}.${randomUUID()}.backup`;
  const handle = await open(temporaryPath, 'wx');

  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    const targetStat = await stat(targetPath);
    await chmod(temporaryPath, targetStat.mode);
    await rename(targetPath, backupPath);
  } catch (error) {
    throw replacementError(
      `The save could not move the current project aside safely: ${errorMessage(error)}`,
      [temporaryPath],
      error,
    );
  }

  let displaced: Buffer;
  try {
    displaced = await readFile(backupPath);
  } catch (error) {
    throw replacementError(
      `The displaced project could not be verified: ${errorMessage(error)}`,
      await existingPaths([backupPath, temporaryPath]),
      error,
    );
  }
  if (hashBytes(displaced) !== expectedHash) {
    const restored = await restoreDisplacedFile(backupPath, targetPath);
    throw replacementError(
      restored
        ? 'The project changed while it was being saved. The external version was restored.'
        : 'The project changed while it was being saved, and its path was already occupied before restoration.',
      restored ? [temporaryPath] : [backupPath, temporaryPath],
    );
  }

  try {
    await link(temporaryPath, targetPath);
  } catch (error) {
    const restored = await restoreDisplacedFile(backupPath, targetPath);
    throw replacementError(
      restored
        ? `The save could not install the edited project, so the original was restored: ${errorMessage(error)}`
        : `The save could not install the edited project or restore its original path: ${errorMessage(error)}`,
      restored ? [temporaryPath] : [backupPath, temporaryPath],
      error,
    );
  }

  let installed: Buffer;
  let finalDisplaced: Buffer;
  try {
    [installed, finalDisplaced] = await Promise.all([
      readFile(targetPath),
      readFile(backupPath),
    ]);
  } catch (error) {
    throw replacementError(
      `The project files could not be read during final save verification: ${errorMessage(error)}`,
      await existingPaths([temporaryPath, backupPath]),
      error,
    );
  }
  if (
    hashBytes(installed) !== hashBytes(content) ||
    hashBytes(finalDisplaced) !== expectedHash
  ) {
    throw replacementError(
      'The project files changed during final save verification.',
      [temporaryPath, backupPath],
    );
  }

  try {
    await unlink(temporaryPath);
  } catch (error) {
    throw replacementError(
      `The project was saved, but its edited recovery link could not be removed: ${errorMessage(error)}`,
      [temporaryPath, backupPath],
      error,
    );
  }

  try {
    await unlink(backupPath);
  } catch (error) {
    throw replacementError(
      `The project was saved, but its original backup could not be removed: ${errorMessage(error)}`,
      [backupPath],
      error,
    );
  }
}

export function hashBytes(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function restoreDisplacedFile(
  backupPath: string,
  targetPath: string,
): Promise<boolean> {
  try {
    await link(backupPath, targetPath);
    await unlink(backupPath);
    return true;
  } catch {
    return false;
  }
}

async function existingPaths(paths: readonly string[]): Promise<string[]> {
  const checks = await Promise.all(
    paths.map(async (filePath) => {
      try {
        await access(filePath);
        return filePath;
      } catch {
        return undefined;
      }
    }),
  );
  return checks.filter((filePath): filePath is string => filePath !== undefined);
}

function replacementError(
  message: string,
  recoveryPaths: readonly string[],
  cause?: unknown,
): ConditionalFileReplaceError {
  const recovery =
    recoveryPaths.length === 0
      ? ''
      : recoveryPaths.length === 1
      ? ` Recovery copy: "${recoveryPaths[0]}".`
      : ` Recovery copies: ${recoveryPaths
          .map((recoveryPath) => `"${recoveryPath}"`)
          .join(' and ')}.`;
  const options = cause === undefined ? undefined : { cause };
  return new ConditionalFileReplaceError(
    `${message}${recovery}`,
    recoveryPaths,
    options,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
