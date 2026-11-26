// Made-up zip archives for the tests, built byte by byte so a test can also make the wrong ones: a password flag, sizes that lie,
// an unknown compression, a cut-off file. Nothing here reads or writes a file.
import { deflateRawSync, crc32 } from "node:zlib";

const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xFFFF); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
export const ZIP_STORED = 0, ZIP_DEFLATED = 8, ZIP_ENCRYPTED = 1;
const ZIP_DESCRIPTOR = 8;

/* files: [{ name, data, method = deflate, flags = 0, lie: { size, crc, packed, method }, descriptor, localExtra, centralExtra }].
   `lie` replaces what the headers claim. `descriptor: true` writes the entry the way macOS and iOS do: the header before the data holds
   zeros for the checksum and sizes, which follow the data instead; only the list at the end of the archive has them.
   `localExtra` and `centralExtra` are numbers of extra-field bytes in the two headers (real archives carry timestamps there, of different lengths). */
export function makeZip(files, { comment = "" } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.data || ""), method = f.method ?? ZIP_DEFLATED, lie = f.lie || {};
    const packed = method === ZIP_DEFLATED ? deflateRawSync(data, { level: 9 }) : data, name = Buffer.from(f.name, "utf8");
    const flags = (f.flags || 0) | (f.descriptor ? ZIP_DESCRIPTOR : 0), sums = Buffer.concat([u32(lie.crc ?? crc32(data)), u32(lie.packed ?? packed.length), u32(lie.size ?? data.length)]);
    const lead = Buffer.concat([u16(flags), u16(lie.method ?? method), u16(0), u16(0x5A21)]);
    const localExtra = Buffer.alloc(f.localExtra || 0, 0x55), centralExtra = Buffer.alloc(f.centralExtra || 0, 0x55);
    const local = Buffer.concat([u32(0x04034b50), u16(20), lead, f.descriptor ? Buffer.alloc(12) : sums, u16(name.length), u16(localExtra.length), name, localExtra, packed,
      f.descriptor ? Buffer.concat([u32(0x08074b50), sums]) : Buffer.alloc(0)]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), lead, sums, u16(name.length), u16(centralExtra.length), u16(0), u16(0), u16(0), u32(0), u32(offset), name, centralExtra]));
    locals.push(local); offset += local.length;
  }
  const dir = Buffer.concat(centrals), note = Buffer.from(comment, "utf8");
  return Buffer.concat([...locals, dir, u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(dir.length), u32(offset), u16(note.length), note]);
}
