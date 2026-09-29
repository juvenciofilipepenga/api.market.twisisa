import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { uploadImageBuffer } from "../services/cloudinary.js";

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.post("/media/image", { preHandler: requireAuth }, async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "FILE_REQUIRED" });
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(file.mimetype)) return reply.code(415).send({ error: "UNSUPPORTED_FILE_TYPE" });
    const buffer = await file.toBuffer();
    if (buffer.length === 0) return reply.code(400).send({ error: "EMPTY_FILE" });
    try {
      const result = await uploadImageBuffer(buffer);
      return { url: result.secure_url ?? result.url, publicId: result.public_id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "UPLOAD_FAILED";
      return reply.code(503).send({ error: message });
    }
  });
}
