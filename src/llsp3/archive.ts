import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  applyEdits,
  modify,
  parse,
  type ParseError,
  printParseErrorCode,
} from 'jsonc-parser';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTED_FLAG = 0x0001;
const STRONG_ENCRYPTION_FLAG = 0x0040;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

export type Llsp3ErrorCode =
  | 'invalid-zip'
  | 'unsupported-zip'
  | 'missing-entry'
  | 'duplicate-entry'
  | 'invalid-json'
  | 'not-python'
  | 'invalid-project';

export class Llsp3Error extends Error {
  public constructor(
    public readonly code: Llsp3ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Llsp3Error';
  }
}

export interface Llsp3Project {
  readonly source: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly projectBody: Readonly<Record<string, unknown>>;
  readonly manifestText: string;
  readonly projectBodyText: string;
  readonly entryNames: readonly string[];
}

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly localHeaderLength: number;
  readonly dataStart: number;
  readonly dataEnd: number;
  recordEnd: number;
  readonly centralRecord: Buffer;
}

interface ZipArchive {
  readonly bytes: Buffer;
  readonly entries: readonly ZipEntry[];
  readonly entriesByName: ReadonlyMap<string, readonly ZipEntry[]>;
  readonly prefix: Buffer;
  readonly centralDirectorySuffix: Buffer;
  readonly postCentralDirectory: Buffer;
  readonly endOfCentralDirectory: Buffer;
}

export function readLlsp3Project(input: Uint8Array): Llsp3Project {
  const archive = parseZipArchive(toBuffer(input));
  const manifestEntry = requireUniqueEntry(archive, 'manifest.json');
  const manifestText = decodeUtf8(readZipEntry(archive, manifestEntry), 'manifest.json');
  const manifest = parseJsonObject(manifestText, 'manifest.json');

  if (manifest.type !== 'python') {
    const projectType =
      typeof manifest.type === 'string' ? `"${manifest.type}"` : 'an unknown type';
    throw new Llsp3Error(
      'not-python',
      `This LLSP3 project is ${projectType}, not a Python project.`,
    );
  }

  const bodyEntry = requireUniqueEntry(archive, 'projectbody.json');
  const projectBodyText = decodeUtf8(
    readZipEntry(archive, bodyEntry),
    'projectbody.json',
  );
  const projectBody = parseJsonObject(projectBodyText, 'projectbody.json');

  if (typeof projectBody.main !== 'string') {
    throw new Llsp3Error(
      'invalid-project',
      'projectbody.json must contain a string property named "main".',
    );
  }

  return {
    source: projectBody.main,
    manifest,
    projectBody,
    manifestText,
    projectBodyText,
    entryNames: archive.entries.map((entry) => entry.name),
  };
}

export function updateLlsp3Source(
  input: Uint8Array,
  source: string,
): Uint8Array {
  const bytes = toBuffer(input);
  const currentProject = readLlsp3Project(bytes);

  if (currentProject.source === source) {
    return Uint8Array.from(bytes);
  }

  const edits = modify(currentProject.projectBodyText, ['main'], source, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: currentProject.projectBodyText.includes('\r\n') ? '\r\n' : '\n',
    },
  });
  const updatedProjectBody = applyEdits(currentProject.projectBodyText, edits);
  const archive = parseZipArchive(bytes);
  const bodyEntry = requireUniqueEntry(archive, 'projectbody.json');
  const updatedArchive = replaceZipEntry(
    archive,
    bodyEntry,
    Buffer.from(updatedProjectBody, 'utf8'),
  );

  const verifiedProject = readLlsp3Project(updatedArchive);
  if (verifiedProject.source !== source) {
    throw new Llsp3Error(
      'invalid-project',
      'The LLSP3 archive failed source verification after it was updated.',
    );
  }

  return Uint8Array.from(updatedArchive);
}

function parseZipArchive(bytes: Buffer): ZipArchive {
  const endOffset = findEndOfCentralDirectory(bytes);
  const endRecord = bytes.subarray(endOffset);

  if (
    endOffset >= 20 &&
    bytes.readUInt32LE(endOffset - 20) ===
      ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE
  ) {
    throw unsupportedZip('ZIP64 archives are not supported.');
  }

  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const centralDirectorySize = bytes.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(endOffset + 16);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== totalEntries
  ) {
    throw unsupportedZip('Multi-disk ZIP archives are not supported.');
  }

  if (
    totalEntries === MAX_UINT16 ||
    centralDirectorySize === MAX_UINT32 ||
    centralDirectoryOffset === MAX_UINT32
  ) {
    throw unsupportedZip('ZIP64 archives are not supported.');
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryOffset > bytes.length ||
    centralDirectoryEnd > endOffset
  ) {
    throw invalidZip('The central directory points outside the archive.');
  }

  const entries: ZipEntry[] = [];
  let centralOffset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    ensureAvailable(bytes, centralOffset, 46, 'central directory entry');
    if (bytes.readUInt32LE(centralOffset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw invalidZip(`Central directory entry ${index + 1} is malformed.`);
    }

    const flags = bytes.readUInt16LE(centralOffset + 8);
    const compressionMethod = bytes.readUInt16LE(centralOffset + 10);
    const crc = bytes.readUInt32LE(centralOffset + 16);
    const compressedSize = bytes.readUInt32LE(centralOffset + 20);
    const uncompressedSize = bytes.readUInt32LE(centralOffset + 24);
    const fileNameLength = bytes.readUInt16LE(centralOffset + 28);
    const extraLength = bytes.readUInt16LE(centralOffset + 30);
    const commentLength = bytes.readUInt16LE(centralOffset + 32);
    const startDisk = bytes.readUInt16LE(centralOffset + 34);
    const localHeaderOffset = bytes.readUInt32LE(centralOffset + 42);
    const recordLength = 46 + fileNameLength + extraLength + commentLength;

    ensureAvailable(bytes, centralOffset, recordLength, 'central directory entry');

    if (
      compressedSize === MAX_UINT32 ||
      uncompressedSize === MAX_UINT32 ||
      localHeaderOffset === MAX_UINT32
    ) {
      throw unsupportedZip('ZIP64 entries are not supported.');
    }

    if (startDisk !== 0) {
      throw unsupportedZip('Multi-disk ZIP entries are not supported.');
    }

    if ((flags & (ENCRYPTED_FLAG | STRONG_ENCRYPTION_FLAG)) !== 0) {
      throw unsupportedZip('Encrypted ZIP entries are not supported.');
    }

    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw unsupportedZip(
        `ZIP compression method ${compressionMethod} is not supported.`,
      );
    }

    const nameBytes = bytes.subarray(
      centralOffset + 46,
      centralOffset + 46 + fileNameLength,
    );
    const name = decodeZipName(nameBytes, flags);
    const centralRecord = Buffer.from(
      bytes.subarray(centralOffset, centralOffset + recordLength),
    );

    ensureAvailable(bytes, localHeaderOffset, 30, `local header for ${name}`);
    if (bytes.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw invalidZip(`The local header for "${name}" is malformed.`);
    }

    const localFlags = bytes.readUInt16LE(localHeaderOffset + 6);
    const localMethod = bytes.readUInt16LE(localHeaderOffset + 8);
    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const localHeaderLength = 30 + localNameLength + localExtraLength;
    const dataStart = localHeaderOffset + localHeaderLength;
    const dataEnd = dataStart + compressedSize;

    ensureAvailable(bytes, localHeaderOffset, localHeaderLength, `local header for ${name}`);
    ensureAvailable(bytes, dataStart, compressedSize, `compressed data for ${name}`);

    const localName = decodeZipName(
      bytes.subarray(
        localHeaderOffset + 30,
        localHeaderOffset + 30 + localNameLength,
      ),
      localFlags,
    );

    if (localName !== name || localMethod !== compressionMethod) {
      throw invalidZip(
        `The local and central directory records for "${name}" do not match.`,
      );
    }

    entries.push({
      name,
      flags,
      compressionMethod,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      localHeaderLength,
      dataStart,
      dataEnd,
      recordEnd: 0,
      centralRecord,
    });

    centralOffset += recordLength;
  }

  if (centralOffset > centralDirectoryEnd) {
    throw invalidZip('The central directory size is inconsistent.');
  }

  const localEntries = [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  for (let index = 0; index < localEntries.length; index += 1) {
    const entry = localEntries[index];
    if (entry === undefined) {
      continue;
    }

    const nextEntry = localEntries[index + 1];
    entry.recordEnd = nextEntry?.localHeaderOffset ?? centralDirectoryOffset;

    if (
      entry.localHeaderOffset < 0 ||
      entry.dataEnd > entry.recordEnd ||
      entry.recordEnd > centralDirectoryOffset
    ) {
      throw invalidZip(`The local record for "${entry.name}" overlaps another record.`);
    }
  }

  const entriesByName = new Map<string, ZipEntry[]>();
  for (const entry of entries) {
    const matchingEntries = entriesByName.get(entry.name) ?? [];
    matchingEntries.push(entry);
    entriesByName.set(entry.name, matchingEntries);
  }

  const firstLocalOffset =
    localEntries[0]?.localHeaderOffset ?? centralDirectoryOffset;

  return {
    bytes,
    entries,
    entriesByName,
    prefix: Buffer.from(bytes.subarray(0, firstLocalOffset)),
    centralDirectorySuffix: Buffer.from(
      bytes.subarray(centralOffset, centralDirectoryEnd),
    ),
    postCentralDirectory: Buffer.from(
      bytes.subarray(centralDirectoryEnd, endOffset),
    ),
    endOfCentralDirectory: Buffer.from(endRecord),
  };
}

function replaceZipEntry(
  archive: ZipArchive,
  target: ZipEntry,
  replacement: Buffer,
): Buffer {
  if (replacement.length > MAX_UINT32) {
    throw unsupportedZip('The replacement file is too large for a standard ZIP archive.');
  }

  const compressed =
    target.compressionMethod === 0
      ? replacement
      : deflateRawSync(replacement);

  if (compressed.length > MAX_UINT32) {
    throw unsupportedZip('The compressed replacement is too large.');
  }

  const crc = crc32(replacement);
  let flags = target.flags & ~DATA_DESCRIPTOR_FLAG;
  if (target.compressionMethod === 8) {
    flags &= ~0x0006;
  }

  const localHeader = Buffer.from(
    archive.bytes.subarray(
      target.localHeaderOffset,
      target.localHeaderOffset + target.localHeaderLength,
    ),
  );
  localHeader.writeUInt16LE(flags, 6);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(replacement.length, 22);

  const targetTail = archive.bytes.subarray(target.dataEnd, target.recordEnd);
  const preservedTail = stripDataDescriptor(target, targetTail);
  const replacementRecord = Buffer.concat([
    localHeader,
    compressed,
    preservedTail,
  ]);

  const localEntries = [...archive.entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  const newOffsets = new Map<ZipEntry, number>();
  const localParts: Buffer[] = [archive.prefix];
  let nextOffset = archive.prefix.length;

  for (const entry of localEntries) {
    newOffsets.set(entry, nextOffset);
    const record =
      entry === target
        ? replacementRecord
        : Buffer.from(
            archive.bytes.subarray(entry.localHeaderOffset, entry.recordEnd),
          );
    localParts.push(record);
    nextOffset += record.length;
  }

  const centralDirectoryOffset = nextOffset;
  const centralRecords = archive.entries.map((entry) => {
    const record = Buffer.from(entry.centralRecord);
    const localOffset = newOffsets.get(entry);
    if (localOffset === undefined || localOffset > MAX_UINT32) {
      throw unsupportedZip('The updated archive requires ZIP64 offsets.');
    }

    record.writeUInt32LE(localOffset, 42);
    if (entry === target) {
      record.writeUInt16LE(flags, 8);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(compressed.length, 20);
      record.writeUInt32LE(replacement.length, 24);
    }
    return record;
  });
  const centralDirectory = Buffer.concat([
    ...centralRecords,
    archive.centralDirectorySuffix,
  ]);

  if (
    centralDirectory.length > MAX_UINT32 ||
    centralDirectoryOffset > MAX_UINT32
  ) {
    throw unsupportedZip('The updated archive requires ZIP64 metadata.');
  }

  const endRecord = Buffer.from(archive.endOfCentralDirectory);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(centralDirectoryOffset, 16);

  return Buffer.concat([
    ...localParts,
    centralDirectory,
    archive.postCentralDirectory,
    endRecord,
  ]);
}

function readZipEntry(archive: ZipArchive, entry: ZipEntry): Buffer {
  const compressed = archive.bytes.subarray(entry.dataStart, entry.dataEnd);
  let uncompressed: Buffer;

  try {
    uncompressed =
      entry.compressionMethod === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed);
  } catch (error) {
    throw invalidZip(
      `The compressed data for "${entry.name}" could not be decompressed: ${errorMessage(error)}`,
    );
  }

  if (uncompressed.length !== entry.uncompressedSize) {
    throw invalidZip(`The size recorded for "${entry.name}" is incorrect.`);
  }

  if (crc32(uncompressed) !== entry.crc32) {
    throw invalidZip(`The CRC recorded for "${entry.name}" is incorrect.`);
  }

  return uncompressed;
}

function requireUniqueEntry(archive: ZipArchive, name: string): ZipEntry {
  const matchingEntries = archive.entriesByName.get(name) ?? [];
  if (matchingEntries.length === 0) {
    throw new Llsp3Error(
      'missing-entry',
      `The LLSP3 archive does not contain "${name}".`,
    );
  }

  if (matchingEntries.length > 1) {
    throw new Llsp3Error(
      'duplicate-entry',
      `The LLSP3 archive contains more than one "${name}" entry.`,
    );
  }

  const entry = matchingEntries[0];
  if (entry === undefined) {
    throw invalidZip(`The "${name}" entry could not be read.`);
  }
  return entry;
}

function stripDataDescriptor(entry: ZipEntry, tail: Buffer): Buffer {
  if ((entry.flags & DATA_DESCRIPTOR_FLAG) === 0) {
    return Buffer.from(tail);
  }

  if (
    tail.length >= 16 &&
    tail.readUInt32LE(0) === DATA_DESCRIPTOR_SIGNATURE &&
    dataDescriptorMatches(entry, tail, 4)
  ) {
    return Buffer.from(tail.subarray(16));
  }

  if (tail.length >= 12 && dataDescriptorMatches(entry, tail, 0)) {
    return Buffer.from(tail.subarray(12));
  }

  throw invalidZip(`The data descriptor for "${entry.name}" is inconsistent.`);
}

function dataDescriptorMatches(
  entry: ZipEntry,
  tail: Buffer,
  offset: number,
): boolean {
  return (
    tail.readUInt32LE(offset) === entry.crc32 &&
    tail.readUInt32LE(offset + 4) === entry.compressedSize &&
    tail.readUInt32LE(offset + 8) === entry.uncompressedSize
  );
}

function parseJsonObject(
  text: string,
  entryName: string,
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });

  if (errors.length > 0) {
    const firstError = errors[0];
    const description =
      firstError === undefined
        ? 'unknown JSON error'
        : `${printParseErrorCode(firstError.error)} at offset ${firstError.offset}`;
    throw new Llsp3Error(
      'invalid-json',
      `${entryName} is not valid JSON: ${description}.`,
    );
  }

  if (!isRecord(value)) {
    throw new Llsp3Error(
      'invalid-json',
      `${entryName} must contain a JSON object.`,
    );
  }

  return value;
}

function decodeUtf8(bytes: Buffer, entryName: string): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.startsWith('\uFEFF') ? text.slice(1) : text;
  } catch (error) {
    throw new Llsp3Error(
      'invalid-json',
      `${entryName} is not valid UTF-8: ${errorMessage(error)}`,
    );
  }
}

function decodeZipName(bytes: Buffer, flags: number): string {
  if ((flags & UTF8_FLAG) !== 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw invalidZip(`A ZIP entry name is not valid UTF-8: ${errorMessage(error)}`);
    }
  }

  return bytes.toString('latin1');
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  if (bytes.length < 22) {
    throw invalidZip('The file is too small to be a ZIP archive.');
  }

  const minimumOffset = Math.max(0, bytes.length - 22 - MAX_UINT16);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }

    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) {
      return offset;
    }
  }

  throw invalidZip('The ZIP end-of-central-directory record was not found.');
}

function ensureAvailable(
  bytes: Buffer,
  offset: number,
  length: number,
  description: string,
): void {
  if (
    offset < 0 ||
    length < 0 ||
    offset > bytes.length ||
    length > bytes.length - offset
  ) {
    throw invalidZip(`The ${description} is truncated.`);
  }
}

function toBuffer(input: Uint8Array): Buffer {
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidZip(message: string): Llsp3Error {
  return new Llsp3Error('invalid-zip', message);
}

function unsupportedZip(message: string): Llsp3Error {
  return new Llsp3Error('unsupported-zip', message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CRC_TABLE = createCrcTable();

function createCrcTable(): Uint32Array {
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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const tableValue = CRC_TABLE[(crc ^ byte) & 0xff];
    if (tableValue === undefined) {
      throw new Error('CRC table lookup failed.');
    }
    crc = tableValue ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
