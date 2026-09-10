'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CRC_TABLE = createCrcTable();

try {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error('usage: node llsp3-textconv.cjs <project.llsp3>');
  }

  const archive = fs.readFileSync(filePath);
  const entries = readCentralDirectory(archive);
  const manifest = parseJsonEntry(
    readEntry(archive, requireEntry(entries, 'manifest.json')),
  );
  if (manifest.type !== 'python') {
    throw new Error(`project type is ${JSON.stringify(manifest.type)}, not "python"`);
  }

  const projectBody = parseJsonEntry(
    readEntry(archive, requireEntry(entries, 'projectbody.json')),
  );
  if (typeof projectBody.main !== 'string') {
    throw new Error('projectbody.json does not contain a string "main" property');
  }

  process.stdout.write(projectBody.main);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  let digest = 'unavailable';
  try {
    const filePath = process.argv[2];
    if (filePath) {
      digest = crypto
        .createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex');
    }
  } catch {
    digest = 'unavailable';
  }
  process.stdout.write(
    `# LLSP3 text conversion unavailable: ${singleLine(message)}\n` +
      `# archive-sha256: ${digest}\n`,
  );
}

function parseJsonEntry(contents) {
  const text = contents.toString('utf8');
  return JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
}

function singleLine(value) {
  return value.replace(/[\r\n]+/gu, ' ').trim();
}

function readCentralDirectory(archive) {
  const endOffset = findEndRecord(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const entries = [];
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > archive.length ||
      archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new Error('invalid ZIP central directory');
    }

    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;

    if (offset + recordLength > archive.length) {
      throw new Error('truncated ZIP central directory entry');
    }

    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset += recordLength;
  }

  return entries;
}

function readEntry(archive, entry) {
  if (
    entry.localOffset + 30 > archive.length ||
    archive.readUInt32LE(entry.localOffset) !== 0x04034b50
  ) {
    throw new Error(`invalid local header for ${entry.name}`);
  }

  const nameLength = archive.readUInt16LE(entry.localOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localOffset + 28);
  const localMethod = archive.readUInt16LE(entry.localOffset + 8);
  if (localMethod !== entry.method) {
    throw new Error(`local and central compression methods differ for ${entry.name}`);
  }
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > archive.length) {
    throw new Error(`truncated data for ${entry.name}`);
  }

  const compressed = archive.subarray(dataStart, dataEnd);
  let contents;
  if (entry.method === 0) {
    contents = Buffer.from(compressed);
  } else if (entry.method === 8) {
    contents = zlib.inflateRawSync(compressed);
  } else {
    throw new Error(`unsupported ZIP compression method ${entry.method}`);
  }

  if (contents.length !== entry.uncompressedSize) {
    throw new Error(`incorrect uncompressed size for ${entry.name}`);
  }
  if (crc32(contents) !== entry.crc) {
    throw new Error(`incorrect CRC for ${entry.name}`);
  }
  return contents;
}

function requireEntry(entries, name) {
  const matches = entries.filter((entry) => entry.name === name);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `archive does not contain ${name}`
        : `archive contains duplicate ${name} entries`,
    );
  }
  return matches[0];
}

function findEndRecord(archive) {
  const minimumOffset = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) {
      return offset;
    }
  }
  throw new Error('ZIP end-of-central-directory record not found');
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) !== 0
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
