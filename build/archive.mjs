import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw } from "node:zlib";
import path from "node:path";

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

// ZIP32 is sufficient for this pinned distribution. Refuse overflow, never emit a corrupt ZIP.
export async function writeZip(root, files, destination, epoch) {
  if (files.length >= 65535) throw new Error("ZIP32 file-count limit exceeded");
  const handle = await open(destination, "wx");
  let position = 0;
  const entries = [];
  const date = new Date(epoch * 1000);
  const dosTime =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate =
    ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  async function append(bytes) {
    if (position + bytes.length >= 0xffffffff) throw new Error("ZIP32 size limit exceeded");
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, position);
      if (!result.bytesWritten) throw new Error("Archive write made no progress");
      written += result.bytesWritten;
      position += result.bytesWritten;
    }
  }
  try {
    for (const file of files) {
      const name = Buffer.from(file.path, "utf8");
      if (name.length > 65535) throw new Error(`ZIP path too long: ${file.path}`);
      const offset = position;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x808, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(dosTime, 10);
      header.writeUInt16LE(dosDate, 12);
      header.writeUInt16LE(name.length, 26);
      await append(header);
      await append(name);
      const dataStart = position;
      let crc = 0xffffffff;
      let size = 0;
      await pipeline(
        createReadStream(path.join(root, file.path)),
        new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
            callback(null, chunk);
          },
        }),
        createDeflateRaw({ level: 6 }),
        new Writable({
          write(chunk, _encoding, callback) {
            append(chunk).then(() => callback(), callback);
          },
        }),
      );
      if (size !== file.size || size >= 0xffffffff)
        throw new Error(`File changed during archive: ${file.path}`);
      crc = (crc ^ 0xffffffff) >>> 0;
      const compressed = position - dataStart;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed, 8);
      descriptor.writeUInt32LE(size, 12);
      await append(descriptor);
      entries.push({ name, offset, crc, compressed, size });
    }
    const centralStart = position;
    for (const entry of entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x808, 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(dosTime, 12);
      header.writeUInt16LE(dosDate, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE(entry.offset, 42);
      await append(header);
      await append(entry.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(position - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    await append(end);
  } finally {
    await handle.close();
  }
}
