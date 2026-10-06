// O mimetype que vem no multipart é declarado pelo cliente; o tipo real vê-se nos primeiros bytes.
export type DetectedMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export function detectMime(buffer: Buffer): DetectedMime | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

export function isFileTooLarge(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE";
}
