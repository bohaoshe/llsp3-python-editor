import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import {
  Llsp3Error,
  readLlsp3Project,
  updateLlsp3Source,
} from '../src/llsp3/archive';
import {
  ConditionalFileReplaceError,
  hashBytes,
  replaceFileConditionally,
} from '../src/llsp3/conditionalFileReplace';

const execFileAsync = promisify(execFile);

interface FixtureEntry {
  readonly name: string;
  readonly contents: Buffer;
  readonly compressionMethod?: 0 | 8;
  readonly dataDescriptor?: boolean;
  readonly dataDescriptorSignature?: boolean;
  readonly comment?: string;
  readonly extra?: Buffer;
}

test('reads a Python project from a current LLSP3 layout', () => {
  const archive = createFixtureArchive([
    jsonEntry('manifest.json', { type: 'python', appType: 'llsp3', name: 'Drive' }),
    jsonEntry('projectbody.json', { main: 'print("hello")\n' }),
    {
      name: 'icon.svg',
      contents: Buffer.from('<svg>unchanged</svg>', 'utf8'),
      compressionMethod: 0,
    },
  ]);

  const project = readLlsp3Project(archive);

  assert.equal(project.source, 'print("hello")\n');
  assert.equal(project.manifest.type, 'python');
  assert.deepEqual(project.entryNames, [
    'manifest.json',
    'projectbody.json',
    'icon.svg',
  ]);
});

test('updates Unicode source while preserving unrelated local records', () => {
  const archive = createFixtureArchive(
    [
      {
        ...jsonEntry('manifest.json', {
          type: 'python',
          appType: 'llsp3',
          future: { preserve: true },
        }),
        extra: Buffer.from([0x55, 0x54, 0x01, 0x00]),
      },
      {
        name: 'projectbody.json',
        contents: Buffer.from(
          '{\r\n  "main": "print(\\"old\\")\\n",\r\n  "future": { "x": 1 }\r\n}\r\n',
          'utf8',
        ),
        compressionMethod: 8,
        dataDescriptor: true,
      },
      {
        name: 'icon.svg',
        contents: Buffer.from('<svg>same bytes</svg>', 'utf8'),
        compressionMethod: 8,
        comment: 'keep this comment',
      },
      {
        name: 'monitors.json',
        contents: Buffer.from('{"monitors":[]}', 'utf8'),
        compressionMethod: 0,
      },
    ],
    'archive comment',
  );
  const originalManifestRecord = rawLocalRecord(archive, 'manifest.json');
  const originalIconRecord = rawLocalRecord(archive, 'icon.svg');
  const originalMonitorsRecord = rawLocalRecord(archive, 'monitors.json');
  const newSource = 'print("robot 🤖")\n\n';

  const updated = Buffer.from(updateLlsp3Source(archive, newSource));
  const updatedProject = readLlsp3Project(updated);

  assert.equal(updatedProject.source, newSource);
  assert.match(updatedProject.projectBodyText, /"future": \{ "x": 1 \}/);
  assert.ok(updatedProject.projectBodyText.endsWith('\r\n'));
  assert.deepEqual(rawLocalRecord(updated, 'manifest.json'), originalManifestRecord);
  assert.deepEqual(rawLocalRecord(updated, 'icon.svg'), originalIconRecord);
  assert.deepEqual(rawLocalRecord(updated, 'monitors.json'), originalMonitorsRecord);
  assert.equal(readArchiveComment(updated), 'archive comment');
});

test('returns an unchanged byte sequence when source did not change', () => {
  const archive = createFixtureArchive([
    jsonEntry('manifest.json', { type: 'python' }),
    jsonEntry('projectbody.json', { main: 'pass\n' }),
  ]);

  const updated = Buffer.from(updateLlsp3Source(archive, 'pass\n'));

  assert.deepEqual(updated, archive);
});

test('updates a non-final entry with a signatureless data descriptor', () => {
  const archive = createFixtureArchive([
    jsonEntry('manifest.json', { type: 'python' }),
    {
      ...jsonEntry('projectbody.json', { main: 'old\n' }),
      dataDescriptor: true,
      dataDescriptorSignature: false,
    },
    {
      name: 'icon.svg',
      contents: Buffer.from('<svg>after body</svg>'),
      compressionMethod: 0,
    },
  ]);
  const originalIconRecord = rawLocalRecord(archive, 'icon.svg');

  const updated = Buffer.from(
    updateLlsp3Source(archive, `print("${'x'.repeat(4096)}")\n`),
  );

  assert.match(readLlsp3Project(updated).source, /^print\("x{4096}"\)\n$/u);
  assert.deepEqual(rawLocalRecord(updated, 'icon.svg'), originalIconRecord);
});

test('handles a signatureless descriptor whose CRC equals the signature', () => {
  const collidingBody = Buffer.from('{"main":"# 3nUNj6\\n"}', 'utf8');
  assert.equal(crc32(collidingBody), 0x08074b50);
  const archive = createFixtureArchive([
    jsonEntry('manifest.json', { type: 'python' }),
    {
      name: 'projectbody.json',
      contents: collidingBody,
      compressionMethod: 8,
      dataDescriptor: true,
      dataDescriptorSignature: false,
    },
  ]);

  const updated = Buffer.from(updateLlsp3Source(archive, 'print("fixed")\n'));

  assert.equal(readLlsp3Project(updated).source, 'print("fixed")\n');
});

test('rejects Word Blocks projects', () => {
  const archive = createFixtureArchive([
    jsonEntry('manifest.json', { type: 'word-blocks' }),
    {
      name: 'scratch.sb3',
      contents: Buffer.from('nested archive'),
    },
  ]);

  assert.throws(
    () => readLlsp3Project(archive),
    (error: unknown) =>
      error instanceof Llsp3Error &&
      error.code === 'not-python' &&
      /word-blocks/.test(error.message),
  );
});

test('rejects files that only have an LLSP3 extension', () => {
  assert.throws(
    () => readLlsp3Project(Buffer.from('print("not a zip")\n')),
    (error: unknown) =>
      error instanceof Llsp3Error && error.code === 'invalid-zip',
  );
});

test('bundled textconv prints only the embedded Python source', async () => {
  const source = 'from hub import light_matrix\nlight_matrix.write("Hi")\n';
  const archive = createFixtureArchive([
    jsonEntry('manifest.json', { type: 'python' }),
    jsonEntry('projectbody.json', { main: source }),
    {
      name: 'icon.svg',
      contents: Buffer.from('<svg />'),
    },
  ]);
  const directory = await mkdtemp(path.join(tmpdir(), 'llsp3-test-'));
  const projectPath = path.join(directory, 'project.llsp3');

  try {
    await writeFile(projectPath, archive);
    const scriptPath = path.resolve('resources', 'llsp3-textconv.cjs');
    const result = await execFileAsync(process.execPath, [scriptPath, projectPath], {
      encoding: 'utf8',
    });
    assert.equal(result.stdout, source);
    assert.equal(result.stderr, '');
    assert.deepEqual(await readFile(projectPath), archive);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bundled textconv degrades safely for non-Python projects', async () => {
  const archive = createFixtureArchive([
    jsonEntry('manifest.json', { type: 'word-blocks' }),
    {
      name: 'scratch.sb3',
      contents: Buffer.from('nested archive'),
    },
  ]);
  const directory = await mkdtemp(path.join(tmpdir(), 'llsp3-test-'));
  const projectPath = path.join(directory, 'blocks.llsp3');

  try {
    await writeFile(projectPath, archive);
    const scriptPath = path.resolve('resources', 'llsp3-textconv.cjs');
    const result = await execFileAsync(process.execPath, [scriptPath, projectPath], {
      encoding: 'utf8',
    });
    assert.match(result.stdout, /text conversion unavailable/u);
    assert.match(result.stdout, /archive-sha256: [a-f0-9]{64}/u);
    assert.equal(result.stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bundled textconv degrades safely for a CRC-corrupt archive', async () => {
  const archive = createFixtureArchive([
    jsonEntry('manifest.json', { type: 'python' }),
    jsonEntry('projectbody.json', { main: 'print("crc")\n' }),
  ]);
  const corruptArchive = corruptCentralCrc(archive, 'projectbody.json');
  const directory = await mkdtemp(path.join(tmpdir(), 'llsp3-test-'));
  const projectPath = path.join(directory, 'corrupt.llsp3');

  try {
    await writeFile(projectPath, corruptArchive);
    const scriptPath = path.resolve('resources', 'llsp3-textconv.cjs');
    const result = await execFileAsync(process.execPath, [scriptPath, projectPath], {
      encoding: 'utf8',
    });
    assert.match(result.stdout, /incorrect CRC/u);
    assert.equal(result.stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('conditional replacement installs the edit without recovery files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'llsp3-replace-'));
  const targetPath = path.join(directory, 'project.llsp3');
  const original = Buffer.from('original archive');
  const edited = Buffer.from('edited archive');

  try {
    await writeFile(targetPath, original);
    await replaceFileConditionally(targetPath, edited, hashBytes(original));

    assert.deepEqual(await readFile(targetPath), edited);
    assert.deepEqual(await readdir(directory), ['project.llsp3']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('conditional replacement restores an externally changed project', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'llsp3-replace-'));
  const targetPath = path.join(directory, 'project.llsp3');
  const expected = Buffer.from('expected archive');
  const external = Buffer.from('external archive');
  const edited = Buffer.from('edited archive');

  try {
    await writeFile(targetPath, external);
    let replacementError: unknown;
    try {
      await replaceFileConditionally(targetPath, edited, hashBytes(expected));
    } catch (error) {
      replacementError = error;
    }
    assert.ok(replacementError instanceof ConditionalFileReplaceError);
    assert.equal(replacementError.recoveryPaths.length, 1);
    assert.deepEqual(
      await readFile(replacementError.recoveryPaths[0] ?? ''),
      edited,
    );
    assert.deepEqual(await readFile(targetPath), external);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('simultaneous conditional writers preserve the losing edit', async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const directory = await mkdtemp(path.join(tmpdir(), 'llsp3-replace-'));
    const targetPath = path.join(directory, 'project.llsp3');
    const original = Buffer.from(`original archive ${attempt}`);
    const editA = Buffer.from(`edit A ${attempt}`);
    const editB = Buffer.from(`edit B ${attempt}`);

    try {
      await writeFile(targetPath, original);
      const results = await Promise.allSettled([
        replaceFileConditionally(targetPath, editA, hashBytes(original)),
        replaceFileConditionally(targetPath, editB, hashBytes(original)),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0]?.reason instanceof ConditionalFileReplaceError);

      const installed = await readFile(targetPath);
      const losingError = rejected[0]?.reason as ConditionalFileReplaceError;
      const recoveryContents = await Promise.all(
        losingError.recoveryPaths.map((recoveryPath) => readFile(recoveryPath)),
      );
      const installedIsA = installed.equals(editA);
      assert.equal(installedIsA || installed.equals(editB), true);
      assert.equal(
        recoveryContents.some((content) =>
          content.equals(installedIsA ? editB : editA),
        ),
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function jsonEntry(name: string, value: unknown): FixtureEntry {
  return {
    name,
    contents: Buffer.from(JSON.stringify(value), 'utf8'),
    compressionMethod: 8,
  };
}

function createFixtureArchive(
  entries: readonly FixtureEntry[],
  archiveComment = '',
): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const extra = entry.extra ?? Buffer.alloc(0);
    const comment = Buffer.from(entry.comment ?? '', 'utf8');
    const method = entry.compressionMethod ?? 8;
    const compressed =
      method === 0 ? entry.contents : deflateRawSync(entry.contents);
    const crc = crc32(entry.contents);
    const flags = 0x0800 | (entry.dataDescriptor === true ? 0x0008 : 0);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0x4a21, 10);
    localHeader.writeUInt16LE(0x5790, 12);
    localHeader.writeUInt32LE(entry.dataDescriptor === true ? 0 : crc, 14);
    localHeader.writeUInt32LE(
      entry.dataDescriptor === true ? 0 : compressed.length,
      18,
    );
    localHeader.writeUInt32LE(
      entry.dataDescriptor === true ? 0 : entry.contents.length,
      22,
    );
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(extra.length, 28);

    const descriptor =
      entry.dataDescriptor === true
        ? createDataDescriptor(
            crc,
            compressed.length,
            entry.contents.length,
            entry.dataDescriptorSignature !== false,
          )
        : Buffer.alloc(0);
    const localRecord = Buffer.concat([
      localHeader,
      name,
      extra,
      compressed,
      descriptor,
    ]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x033f, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0x4a21, 12);
    centralHeader.writeUInt16LE(0x5790, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(extra.length, 30);
    centralHeader.writeUInt16LE(comment.length, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0x20, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([centralHeader, name, extra, comment]));

    localOffset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const comment = Buffer.from(archiveComment, 'utf8');
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  endRecord.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...localRecords, centralDirectory, endRecord, comment]);
}

function createDataDescriptor(
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
  includeSignature: boolean,
): Buffer {
  const descriptor = Buffer.alloc(includeSignature ? 16 : 12);
  const offset = includeSignature ? 4 : 0;
  if (includeSignature) {
    descriptor.writeUInt32LE(0x08074b50, 0);
  }
  descriptor.writeUInt32LE(crc, offset);
  descriptor.writeUInt32LE(compressedSize, offset + 4);
  descriptor.writeUInt32LE(uncompressedSize, offset + 8);
  return descriptor;
}

function rawLocalRecord(archive: Buffer, targetName: string): Buffer {
  const centralOffset = findEndRecord(archive).centralOffset;
  const entries = readCentralEntries(archive);
  const sortedEntries = [...entries].sort(
    (left, right) => left.localOffset - right.localOffset,
  );
  const targetIndex = sortedEntries.findIndex((entry) => entry.name === targetName);
  assert.notEqual(targetIndex, -1);
  const target = sortedEntries[targetIndex];
  assert.ok(target);
  const next = sortedEntries[targetIndex + 1];
  return Buffer.from(
    archive.subarray(target.localOffset, next?.localOffset ?? centralOffset),
  );
}

function readArchiveComment(archive: Buffer): string {
  const end = findEndRecord(archive);
  return archive
    .subarray(end.offset + 22, end.offset + 22 + end.commentLength)
    .toString('utf8');
}

function corruptCentralCrc(archive: Buffer, targetName: string): Buffer {
  const corrupted = Buffer.from(archive);
  const end = findEndRecord(corrupted);
  let offset = end.centralOffset;

  for (let index = 0; index < end.entryCount; index += 1) {
    assert.equal(corrupted.readUInt32LE(offset), 0x02014b50);
    const nameLength = corrupted.readUInt16LE(offset + 28);
    const extraLength = corrupted.readUInt16LE(offset + 30);
    const commentLength = corrupted.readUInt16LE(offset + 32);
    const name = corrupted
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    if (name === targetName) {
      corrupted.writeUInt32LE(
        (corrupted.readUInt32LE(offset + 16) ^ 0xffffffff) >>> 0,
        offset + 16,
      );
      return corrupted;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`Entry not found: ${targetName}`);
}

function readCentralEntries(
  archive: Buffer,
): Array<{ name: string; localOffset: number }> {
  const end = findEndRecord(archive);
  const entries: Array<{ name: string; localOffset: number }> = [];
  let offset = end.centralOffset;

  for (let index = 0; index < end.entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    entries.push({
      name,
      localOffset: archive.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndRecord(archive: Buffer): {
  offset: number;
  entryCount: number;
  centralOffset: number;
  commentLength: number;
} {
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return {
        offset,
        entryCount: archive.readUInt16LE(offset + 10),
        centralOffset: archive.readUInt32LE(offset + 16),
        commentLength: archive.readUInt16LE(offset + 20),
      };
    }
  }
  throw new Error('EOCD not found');
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
