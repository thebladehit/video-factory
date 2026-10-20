/**
 * EXIF Orientation (1–8) з JPEG; 1 — якщо тегу немає. ffmpeg під час декодування сам повертає такий кадр
 * (як і браузер), а ffprobe віддає збережений розмір — тож розміри для геометрії беремо з урахуванням цього тегу.
 */
export function jpegOrientation(buf: Buffer): number {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let off = 2;
  while (off + 4 <= buf.length && buf[off] === 0xff) {
    const marker = buf[off + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // початок даних зображення
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString('binary', off + 4, off + 10) === 'Exif\0\0')
      return tiffOrientation(buf, off + 10);
    off += 2 + len;
  }
  return 1;
}

function tiffOrientation(buf: Buffer, tiff: number): number {
  if (tiff + 8 > buf.length) return 1;
  const le = buf.toString('binary', tiff, tiff + 2) === 'II';
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > buf.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > buf.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}
