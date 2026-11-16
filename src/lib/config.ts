import path from "node:path";

function int(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const config = {
  pythonBin: process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3"),
  engineDir: path.resolve(process.cwd(), "python-engine"),
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), "data", "taskforge.db"),
  execTimeoutMs: int("EXEC_TIMEOUT_MS", 60_000),
  maxOutputBytes: int("MAX_OUTPUT_BYTES", 5_000_000),
  killGraceMs: 2_000,
  limits: { maxPages: 20, maxDepth: 4, defaultPages: 5, defaultDepth: 2 } as {
    maxPages: number; maxDepth: number; defaultPages: number; defaultDepth: number;
  },
  maxPromptChars: 2_000,
};
