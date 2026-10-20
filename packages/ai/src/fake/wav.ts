/** Тиша: PCM 16-bit mono 16 kHz заданої тривалості. */
export function silentWav(durationMs: number): Uint8Array {
  const rate = 16000;
  const dataSize = Math.round((rate * durationMs) / 1000) * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataSize, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataSize, 40);
  return b;
}
