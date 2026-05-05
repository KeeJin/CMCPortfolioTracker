import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Data directory lives at backend/data/, one level above src/ (dev) or dist/ (prod).
export const DATA_DIR = join(__dirname, "..", "data");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Reads a JSON file from the data directory and returns its parsed content.
// Returns fallback if the file doesn't exist or fails to parse.
export function readJson<T>(filename: string, fallback: T): T {
  try {
    const filePath = join(DATA_DIR, filename);
    if (!existsSync(filePath)) {
      return fallback;
    }
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Writes data to a JSON file in the data directory, creating the directory if needed.
export function writeJson(filename: string, data: unknown): void {
  ensureDataDir();
  const filePath = join(DATA_DIR, filename);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}
