import { AppError } from '@vf/shared';

/** Payload задачі має бути простим JSON: лише ідентифікатори й примітиви (spec §4.1, правило 1). */
export function assertSerializablePayload(payload: unknown): void {
  const seen = new WeakSet<object>();
  const fail = (path: string, why: string): never => {
    throw new AppError('INVALID_PAYLOAD', `Payload задачі не є простим JSON (${path}: ${why})`, { path });
  };
  const visit = (v: unknown, path: string): void => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail(path, 'нескінченне число або NaN');
      return;
    }
    if (typeof v !== 'object') return fail(path, typeof v);
    if (seen.has(v)) fail(path, 'циклічне посилання');
    seen.add(v);
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${path}[${i}]`));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) fail(path, v.constructor?.name ?? 'не plain-об’єкт');
    for (const [k, x] of Object.entries(v)) visit(x, `${path}.${k}`);
  };
  visit(payload, 'payload');
}
