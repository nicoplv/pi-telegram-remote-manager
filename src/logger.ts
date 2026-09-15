export type LogLevel = "debug" | "info" | "warn" | "error";

const secretKeys = /token|secret|pairing|payload|authorization/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, secretKeys.test(key) ? "[REDACTED]" : redact(child)]));
}

export function log(level: LogLevel, message: string, context: Record<string, unknown> = {}): void {
  const safeContext = redact(context) as Record<string, unknown>;
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...safeContext })}\n`);
}
