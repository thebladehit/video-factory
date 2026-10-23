/** Тиша: PCM 16-bit mono 16 kHz заданої тривалості. */
export function silentWav(durationMs: number): Uint8Array {
  return toneWav(durationMs, []);
}

/**
 * PCM 16-bit mono 16 kHz: тон 220 Гц (≈ −20 dBFS) на проміжках `spans`, решта — тиша.
 * Так fake-озвучка «звучить» на словах і мовчить у паузах, як справжній TTS (для пошуку тиші).
 */
export function toneWav(durationMs: number, spans: { startMs: number; endMs: number }[]): Uint8Array {
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
  for (const sp of spans) {
    const from = Math.max(0, Math.round((rate * sp.startMs) / 1000));
    const to = Math.min(dataSize / 2, Math.round((rate * sp.endMs) / 1000));
    for (let i = from; i < to; i++) b.writeInt16LE(Math.round(3277 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + i * 2);
  }
  return b;
}
