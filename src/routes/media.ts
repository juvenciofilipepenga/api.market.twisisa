import type { FastifyInstance } from "fastify";
import { detectMime, isFileTooLarge } from "../lib/files.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadImageBuffer } from "../services/cloudinary.js";

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  // Qualquer cliente com sessão pode enviar (comprovativos de pagamento), por isso tem limite próprio mais apertado.
  app.post("/media/image", { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "FILE_REQUIRED" });
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (error) {
      if (isFileTooLarge(error)) return reply.code(413).send({ error: "FILE_TOO_LARGE" });
      throw error;
    }
    if (buffer.length === 0) return reply.code(400).send({ error: "EMPTY_FILE" });
    // Valida pelo conteúdo, não pelo mimetype declarado.
    const detected = detectMime(buffer);
    if (!detected || detected === "application/pdf") return reply.code(415).send({ error: "UNSUPPORTED_FILE_TYPE" });
    try {
      const result = await uploadImageBuffer(buffer);
      return { url: result.secure_url ?? result.url, publicId: result.public_id };
    } catch (error) {
      request.log.error(error, "image upload failed");
      const notConfigured = error instanceof Error && error.message === "CLOUDINARY_NOT_CONFIGURED";
      return reply.code(503).send({ error: notConfigured ? "CLOUDINARY_NOT_CONFIGURED" : "UPLOAD_FAILED" });
    }
  });
}
