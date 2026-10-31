import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { compareText } from '../../shared/ts/src/gen/files.ts';

const BLOCK = 512;
const END_BLOCKS = 2;
const GZIP_OS_OFFSET = 9;
const GZIP_OS_UNIX = 3;
const REGULAR_FILE = '0';
const OCTAL = 8;
const CHECKSUM_DIGITS = 6;
const SPACE = 0x20;
const MAX_UNPACKED_BYTES = 536_870_912;
const USTAR_LAYOUT =
  'name:100 mode:8 uid:8 gid:8 size:12 mtime:12 checksum:8 type:1 linkname:100 magic:6 ' +
  'version:2 uname:32 gname:32 devmajor:8 devminor:8 prefix:155';

type Field =
  | 'name'
  | 'mode'
  | 'uid'
  | 'gid'
  | 'size'
  | 'mtime'
  | 'checksum'
  | 'type'
  | 'linkname'
  | 'magic'
  | 'version'
  | 'prefix';

function layoutOf(spec: string): Map<string, [number, number]> {
  const fields = new Map<string, [number, number]>();
  let offset = 0;
  for (const part of spec.split(' ')) {
    const [name = '', size = ''] = part.split(':');
    fields.set(name, [offset, Number(size)]);
    offset += Number(size);
  }
  return fields;
}

const LAYOUT = layoutOf(USTAR_LAYOUT);

function field(name: Field): [number, number] {
  const found = LAYOUT.get(name);
  if (found === undefined) throw new Error(`unknown ustar field ${name}`);
  return found;
}

const NAME_LENGTH = field('name')[1];

/** One member of a tar archive. `type` is the tar typeflag (`'0'` for a regular file). */
export interface TarMember {
  path: string;
  content: Buffer;
  mode: number;
  type?: string;
  linkname?: string;
}

/** Hex SHA-256 of `bytes`. */
export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function put(header: Buffer, name: Field, value: string): void {
  const [offset, length] = field(name);
  header.write(value, offset, length, 'utf8');
}

function octal(value: number, length: number): string {
  return `${value.toString(OCTAL).padStart(length - 1, '0')}\0`;
}

function headerOf(member: TarMember): Buffer {
  if (Buffer.byteLength(member.path) > NAME_LENGTH) {
    throw new Error(`tar member name too long: ${member.path}`);
  }
  const header = Buffer.alloc(BLOCK);
  put(header, 'name', member.path);
  put(header, 'mode', octal(member.mode, field('mode')[1]));
  put(header, 'uid', octal(0, field('uid')[1]));
  put(header, 'gid', octal(0, field('gid')[1]));
  put(header, 'size', octal(member.content.length, field('size')[1]));
  put(header, 'mtime', octal(0, field('mtime')[1]));
  put(header, 'type', member.type ?? REGULAR_FILE);
  put(header, 'linkname', member.linkname ?? '');
  put(header, 'magic', 'ustar\0');
  put(header, 'version', '00');
  put(header, 'checksum', ' '.repeat(field('checksum')[1]));
  put(
    header,
    'checksum',
    `${checksumOf(header).toString(OCTAL).padStart(CHECKSUM_DIGITS, '0')}\0 `,
  );
  return header;
}

function checksumOf(header: Buffer): number {
  const [offset, length] = field('checksum');
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const inField = index >= offset && index < offset + length;
    sum += inField ? SPACE : (header[index] ?? 0);
  }
  return sum;
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/**
 * Packs `members` into a gzipped ustar archive, sorted by path, with uid, gid and mtime 0 and
 * the gzip OS byte fixed to Unix, so the same members always give the same bytes.
 *
 * @throws {Error} when a member path is longer than 100 bytes.
 */
export function packTar(members: readonly TarMember[]): Buffer {
  const sorted = [...members].sort((a, b) => compareText(a.path, b.path));
  const blocks = sorted.flatMap((member) => [
    headerOf(member),
    member.content,
    padding(member.content.length),
  ]);
  const gz = gzipSync(Buffer.concat([...blocks, Buffer.alloc(BLOCK * END_BLOCKS)]));
  gz[GZIP_OS_OFFSET] = GZIP_OS_UNIX;
  return gz;
}

function text(header: Buffer, name: Field): string {
  const [offset, length] = field(name);
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function number(header: Buffer, name: Field): number {
  const value = text(header, name).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`malformed tar header field ${name}`);
  return Number.parseInt(value, OCTAL);
}

function isEndBlock(header: Buffer): boolean {
  return header.every((byte) => byte === 0);
}

/**
 * Reads a gzipped tar archive into memory. It only parses: member paths and types come back
 * as stored, so callers must validate them before writing anything to disk.
 *
 * @throws {Error} when the data is not gzip, unpacks to more than 512 MiB, a header checksum is
 * wrong or the archive is cut short.
 */
export function unpackTar(gz: Buffer): TarMember[] {
  const tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  const members: TarMember[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (isEndBlock(header)) return members;
    if (number(header, 'checksum') !== checksumOf(header)) {
      throw new Error('tar header checksum mismatch');
    }
    const size = number(header, 'size');
    const start = offset + BLOCK;
    if (start + size > tar.length) throw new Error('tar archive is truncated');
    const prefix = text(header, 'prefix');
    const name = text(header, 'name');
    members.push({
      path: prefix === '' ? name : `${prefix}/${name}`,
      content: Buffer.from(tar.subarray(start, start + size)),
      mode: number(header, 'mode'),
      type: text(header, 'type') || REGULAR_FILE,
      linkname: text(header, 'linkname'),
    });
    offset = start + size + padding(size).length;
  }
  throw new Error('tar archive has no end marker');
}
