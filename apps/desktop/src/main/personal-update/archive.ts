import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** Validate central entries and symlink targets before ditto can write anything. ZIP64 fails closed. */
export function validateUpdateZip(filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  const read = (offset: number, size: number) => {
    const value = Buffer.alloc(size);
    if (fs.readSync(fd, value, 0, size, offset) !== size) throw new Error('Truncated update archive');
    return value;
  };
  try {
    const size = fs.fstatSync(fd).size;
    const tail = read(Math.max(0, size - 65557), Math.min(size, 65557));
    const end = tail.lastIndexOf(Buffer.from('504b0506', 'hex'));
    if (end < 0 || end + 22 > tail.length || end + 22 + tail.readUInt16LE(end + 20) !== tail.length) throw new Error('Invalid ZIP end');
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Multipart ZIP rejected');
    const count = tail.readUInt16LE(end + 10);
    let position = tail.readUInt32LE(end + 16);
    const centralSize = tail.readUInt32LE(end + 12);
    if (count === 65535 || position === 0xffffffff || centralSize > 32 * 1024 ** 2 || position + centralSize > size) throw new Error('Unsupported ZIP directory');
    const names = new Set<string>();
    let expanded = 0;
    for (let index = 0; index < count; index++) {
      const header = read(position, 46);
      if (header.readUInt32LE(0) !== 0x02014b50 || (header.readUInt16LE(8) & 1)) throw new Error('Invalid or encrypted ZIP entry');
      const nameSize = header.readUInt16LE(28), extraSize = header.readUInt16LE(30), commentSize = header.readUInt16LE(32);
      const name = read(position + 46, nameSize).toString('utf8');
      const parts = name.replace(/\/$/, '').split('/');
      if (name.includes('\\') || name.includes('\0') || parts[0] !== 'Cindy.app'
        || parts.some(part => !part || part === '.' || part === '..') || names.has(name.toLowerCase())) throw new Error('Unsafe ZIP path');
      names.add(name.toLowerCase());
      const compressed = header.readUInt32LE(20), length = header.readUInt32LE(24);
      expanded += length;
      if (expanded > 6 * 1024 ** 3 || compressed === 0xffffffff || length === 0xffffffff) throw new Error('Oversized ZIP');
      const mode = header.readUInt32LE(38) >>> 16;
      const kind = mode & 0o170000;
      if (kind && ![0o100000, 0o040000, 0o120000].includes(kind)) throw new Error('Special ZIP file rejected');
      const local = read(header.readUInt32LE(42), 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid ZIP local entry');
      const localName = read(header.readUInt32LE(42) + 30, local.readUInt16LE(26)).toString('utf8');
      if (localName !== name) throw new Error('ZIP local/central path mismatch');
      if (kind === 0o120000) {
        if (compressed > 4096 || length > 4096) throw new Error('Oversized ZIP symlink');
        const content = read(header.readUInt32LE(42) + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), compressed);
        const method = header.readUInt16LE(10);
        const target = (method === 0 ? content : method === 8 ? inflateRawSync(content, { maxOutputLength: 4096 }) : Buffer.alloc(0)).toString('utf8');
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
        if (!target || target.includes('\0') || target.includes('\\') || path.posix.isAbsolute(target)
          || !resolved.startsWith('Cindy.app/')) throw new Error('Escaping ZIP symlink');
      }
      position += 46 + nameSize + extraSize + commentSize;
    }
  } finally { fs.closeSync(fd); }
}

export function verifyExtractedTree(appPath: string): void {
  const base = fs.realpathSync(appPath);
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      const resolved = fs.realpathSync(item);
      if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('Extracted archive escaped app');
      if (entry.isDirectory()) visit(item);
      else if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('Unexpected extracted file');
    }
  };
  visit(base);
}
