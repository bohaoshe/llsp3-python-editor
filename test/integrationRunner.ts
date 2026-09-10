import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import { runTests } from '@vscode/test-electron';
import {
  readLlsp3Project,
  updateLlsp3Source,
} from '../src/llsp3/archive';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(
    extensionDevelopmentPath,
    'dist',
    'test',
    'integration',
    'index',
  );
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), 'llsp3-vscode-integration-'),
  );
  const remotePath = path.join(temporaryRoot, 'remote.git');
  const seedPath = path.join(temporaryRoot, 'seed');
  const workspacePath = path.join(temporaryRoot, 'workspace');

  try {
    await runGit(temporaryRoot, ['init', '--bare', remotePath]);
    await runGit(temporaryRoot, ['init', '-b', 'main', seedPath]);
    await configureIdentity(seedPath);

    const trackedPath = path.join(seedPath, 'tracked.llsp3');
    await writeFile(
      trackedPath,
      createFixtureArchive('print("remote base")\n'),
    );
    await writeFile(
      path.join(seedPath, 'rename-old.llsp3'),
      createFixtureArchive('print("rename remote")\n'),
    );
    await runGit(seedPath, [
      'add',
      'tracked.llsp3',
      'rename-old.llsp3',
    ]);
    await runGit(seedPath, ['commit', '-m', 'Add tracked project']);
    await runGit(seedPath, ['remote', 'add', 'origin', remotePath]);
    await runGit(seedPath, ['push', '-u', 'origin', 'main']);
    await execFileAsync('git', [
      '--git-dir',
      remotePath,
      'symbolic-ref',
      'HEAD',
      'refs/heads/main',
    ]);

    await runGit(temporaryRoot, ['clone', remotePath, workspacePath]);
    await configureIdentity(workspacePath);

    const localTrackedPath = path.join(workspacePath, 'tracked.llsp3');
    const clonedArchive = await readFile(localTrackedPath);
    await writeFile(
      localTrackedPath,
      updateLlsp3Source(clonedArchive, 'print("local committed")\n'),
    );
    await runGit(workspacePath, ['add', 'tracked.llsp3']);
    await runGit(workspacePath, [
      'commit',
      '-m',
      'Local unpushed project update',
    ]);

    const remoteTrackedArchive = await readFile(trackedPath);
    await writeFile(
      trackedPath,
      updateLlsp3Source(
        remoteTrackedArchive,
        'print("remote latest")\n',
      ),
    );
    const remoteOnlySeedPath = path.join(seedPath, 'remote-only.llsp3');
    await writeFile(
      remoteOnlySeedPath,
      createFixtureArchive('print("remote committed")\n'),
    );
    await runGit(seedPath, [
      'add',
      'tracked.llsp3',
      'remote-only.llsp3',
    ]);
    await runGit(seedPath, [
      'commit',
      '-m',
      'Advance remote project versions',
    ]);
    await runGit(seedPath, ['push', 'origin', 'main']);

    const localCommittedArchive = await readFile(localTrackedPath);
    await writeFile(
      localTrackedPath,
      updateLlsp3Source(
        localCommittedArchive,
        'print("staged index")\n',
      ),
    );
    await runGit(workspacePath, ['add', 'tracked.llsp3']);
    const stagedArchive = await readFile(localTrackedPath);
    await writeFile(
      localTrackedPath,
      updateLlsp3Source(
        stagedArchive,
        'print("unstaged working tree")\n',
      ),
    );
    await writeFile(
      path.join(workspacePath, 'remote-only.llsp3'),
      createFixtureArchive('print("local untracked")\n'),
    );
    await runGit(workspacePath, [
      'mv',
      'rename-old.llsp3',
      'rename-new.llsp3',
    ]);
    const renamedArchive = await readFile(
      path.join(workspacePath, 'rename-new.llsp3'),
    );
    await writeFile(
      path.join(workspacePath, 'rename-new.llsp3'),
      updateLlsp3Source(
        renamedArchive,
        'print("rename staged")\n',
      ),
    );
    await runGit(workspacePath, ['add', 'rename-new.llsp3']);
    const stagedRenamedArchive = await readFile(
      path.join(workspacePath, 'rename-new.llsp3'),
    );
    await writeFile(
      path.join(workspacePath, 'rename-new.llsp3'),
      updateLlsp3Source(
        stagedRenamedArchive,
        'print("rename unstaged")\n',
      ),
    );

    const gitExecutablePath = await findGitExecutable();
    await mkdir(path.join(workspacePath, '.vscode'), {
      recursive: true,
    });
    await writeFile(
      path.join(workspacePath, '.vscode', 'settings.json'),
      JSON.stringify({
        'git.path': gitExecutablePath,
      }),
    );
    sanitizeGitConfigEnvironment();
    removeExecutableDirectoryFromPath(gitExecutablePath);

    const vscodeExecutablePath = findVsCodeExecutable();
    await runTests({
      ...(vscodeExecutablePath === undefined
        ? {}
        : { vscodeExecutablePath }),
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  async function findGitExecutable(): Promise<string> {
    const result = await execFileAsync('where.exe', ['git']);
    const executable = result.stdout
      .split(/\r?\n/u)
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0);
    if (executable === undefined) {
      throw new Error('Git executable was not found.');
    }
    return executable;
  }

  function sanitizeGitConfigEnvironment(): void {
    for (const key of Object.keys(process.env)) {
      const normalizedKey = key.toUpperCase();
      if (
        normalizedKey === 'GIT_CONFIG_COUNT' ||
        /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(normalizedKey)
      ) {
        delete process.env[key];
      }
    }
  }

  function removeExecutableDirectoryFromPath(
    executablePath: string,
  ): void {
    const executableDirectory = normalizePath(path.dirname(executablePath));
    const pathKey = Object.keys(process.env).find(
      (key) => key.toLowerCase() === 'path',
    );
    if (pathKey === undefined) {
      return;
    }

    process.env[pathKey] = (process.env[pathKey] ?? '')
      .split(path.delimiter)
      .filter(
        (entry) =>
          normalizePath(path.resolve(entry)) !== executableDirectory,
      )
      .join(path.delimiter);
  }

  function normalizePath(filePath: string): string {
    return process.platform === 'win32'
      ? filePath.toLowerCase()
      : filePath;
  }
}

async function configureIdentity(repositoryPath: string): Promise<void> {
  await runGit(repositoryPath, ['config', 'user.email', 'test@example.com']);
  await runGit(repositoryPath, ['config', 'user.name', 'LLSP3 Test']);
}

async function runGit(
  workingDirectory: string,
  arguments_: readonly string[],
): Promise<void> {
  await execFileAsync('git', ['-C', workingDirectory, ...arguments_]);
}

function findVsCodeExecutable(): string | undefined {
  const configured = process.env.VSCODE_EXECUTABLE_PATH;
  if (configured !== undefined && existsSync(configured)) {
    return configured;
  }

  const candidates = [
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : path.join(
          process.env.LOCALAPPDATA,
          'Programs',
          'Microsoft VS Code',
          'Code.exe',
        ),
    path.join(
      process.env.ProgramFiles ?? 'C:\\Program Files',
      'Microsoft VS Code',
      'Code.exe',
    ),
  ];
  return candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined && existsSync(candidate),
  );
}

function createFixtureArchive(source: string): Buffer {
  const entries = [
    {
      name: 'manifest.json',
      contents: Buffer.from(
        JSON.stringify({ type: 'python', appType: 'llsp3' }),
        'utf8',
      ),
    },
    {
      name: 'projectbody.json',
      contents: Buffer.from(JSON.stringify({ main: source }), 'utf8'),
    },
  ];
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.contents);
    const crc = crc32(entry.contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([localHeader, name, compressed]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x033f, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([centralHeader, name]));
    localOffset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  const archive = Buffer.concat([
    ...localRecords,
    centralDirectory,
    endRecord,
  ]);
  if (readLlsp3Project(archive).source !== source) {
    throw new Error('Integration fixture validation failed.');
  }
  return archive;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        (crc & 1) !== 0
          ? 0xedb88320 ^ (crc >>> 1)
          : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
