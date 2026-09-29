// The JSON API answers with documents whose shape nothing checked, so every read goes through
// these and meets a missing or mistyped field as `undefined` rather than as a throw.

export function fieldOf(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

export function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
