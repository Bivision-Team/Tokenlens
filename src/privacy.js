import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataDir() {
  return process.env.TOKENLENS_DATA_DIR || path.join(os.homedir(), ".tokenlens");
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function secretKey() {
  const file = path.join(dataDir(), "key");
  try {
    return fs.readFileSync(file);
  } catch {
    const key = crypto.randomBytes(32);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, key, { flag: "wx", mode: 0o600 });
      return key;
    } catch {
      return fs.readFileSync(file);
    }
  }
}

export function fingerprint(value) {
  return crypto.createHmac("sha256", secretKey()).update(String(value)).digest("hex");
}

export function measurement(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return {
    chars: [...text].length,
    bytes: Buffer.byteLength(text, "utf8"),
    estimated_tokens: estimateTokens(text),
    content_hmac: fingerprint(text)
  };
}

// Claude exposes no current local tokenizer. This is intentionally an estimate.
export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!text) return 0;
  const bytes = Buffer.byteLength(text, "utf8");
  const words = (text.match(/[\p{L}\p{N}_]+/gu) || []).length;
  return Math.max(1, Math.ceil(Math.max(bytes / 3.6, words * 1.15)));
}

export function safePath(filePath, cwd) {
  if (!filePath) return undefined;
  const absolute = path.resolve(cwd || process.cwd(), filePath);
  const base = path.resolve(cwd || process.cwd());
  const relative = path.relative(base, absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  if (relative === "") return ".";
  return `<external:${fingerprint(absolute).slice(0, 16)}>`;
}

export function writeJsonAtomic(file, object) {
  atomicWrite(file, `${JSON.stringify(object)}\n`);
}
