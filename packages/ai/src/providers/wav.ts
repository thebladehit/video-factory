/** PCM 16-bit little-endian mono → WAV. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const b = Buffer.alloc(44 + pcm.length);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + pcm.length, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(pcm.length, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length).copy(b, 44);
  return b;
}

/** Тривалість PCM-WAV у мс (шукає чанк `data`); null — не WAV. */
export function wavDurationMs(wav: Uint8Array): number | null {
  const b = Buffer.from(wav.buffer, wav.byteOffset, wav.length);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let rate = 0;
  let blockAlign = 0;
  for (let o = 12; o + 8 <= b.length;) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      rate = b.readUInt32LE(o + 12);
      blockAlign = b.readUInt16LE(o + 20);
    } else if (id === 'data') {
      const bytes = Math.min(size, b.length - o - 8);
      return rate && blockAlign ? Math.round((bytes / blockAlign / rate) * 1000) : null;
    }
    o += 8 + size + (size % 2);
  }
  return null;
}
