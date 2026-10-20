import { z } from 'zod';

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  minimum?: number;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
};

function valueFor(s: JsonSchema): unknown {
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  if (s.anyOf?.length) return valueFor(s.anyOf[0]!);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case 'object':
      return Object.fromEntries((s.required ?? []).map((k) => [k, valueFor(s.properties?.[k] ?? {})]));
    case 'array':
      return Array.from({ length: Math.max(s.minItems ?? 0, 1) }, () => valueFor(s.items ?? {}));
    case 'number':
    case 'integer':
      return s.minimum ?? 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return 'fake';
  }
}

/** Мінімальне валідне значення для Zod-схеми (для FakeProvider). */
export function fakeValueFor<T>(schema: z.ZodType<T>): T {
  return schema.parse(valueFor(z.toJSONSchema(schema) as JsonSchema));
}
