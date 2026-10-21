type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (level === "debug" && !process.env.DEBUG) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message } : v,
  );
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
