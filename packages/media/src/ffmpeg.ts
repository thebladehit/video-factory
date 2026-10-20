import { spawn } from 'node:child_process';

export interface MediaTools {
  ffmpegPath: string;
  ffprobePath: string;
}

const STDERR_TAIL = 2000;

/** Збій ffmpeg/ffprobe: ненульовий код виходу, таймаут або скасування (ENOENT лишається системною помилкою). */
export class MediaToolError extends Error {
  constructor(
    message: string,
    readonly reason: 'exit' | 'timeout' | 'aborted',
  ) {
    super(message);
    this.name = 'MediaToolError';
  }
}

/** Запуск ffmpeg/ffprobe окремим процесом: таймаут, скасування, хвіст stderr у помилці. */
export function run(
  bin: string,
  args: string[],
  { signal, timeoutMs = 60_000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MediaToolError('Скасовано', 'aborted'));
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    let reason: 'timeout' | 'aborted' | null = null;
    const kill = (why: 'timeout' | 'aborted') => {
      reason = why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const onAbort = () => kill('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-STDERR_TAIL);
    });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('close', (code) => {
      done();
      if (reason === 'timeout') return reject(new MediaToolError(`${bin}: таймаут ${timeoutMs} мс`, 'timeout'));
      if (reason === 'aborted') return reject(new MediaToolError(`${bin}: скасовано`, 'aborted'));
      if (code !== 0) return reject(new MediaToolError(`${bin} завершився з кодом ${code}: ${stderr.trim()}`, 'exit'));
      resolve({ stdout: Buffer.concat(out), stderr });
    });
  });
}

export async function checkTools(tools: MediaTools): Promise<boolean> {
  try {
    await run(tools.ffprobePath, ['-version'], { timeoutMs: 5000 });
    await run(tools.ffmpegPath, ['-version'], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}
