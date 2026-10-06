import { v2 as cloudinary } from "cloudinary";
import { cloudinaryConfigured, env } from "../config/env.js";

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME!,
    api_key: env.CLOUDINARY_API_KEY!,
    api_secret: env.CLOUDINARY_API_SECRET!
  });
}

export function uploadImageBuffer(buffer: Buffer, folder = "twisisa_market/produtos") {
  if (!cloudinaryConfigured) throw new Error("CLOUDINARY_NOT_CONFIGURED");
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        transformation: [{ width: 800, height: 800, crop: "limit", quality: "auto", fetch_format: "webp" }]
      },
      (error, result) => error ? reject(error) : resolve((result ?? {}) as Record<string, unknown>)
    );
    stream.end(buffer);
  });
}

// Anexos de chat: imagens são otimizadas; outros ficheiros (PDF, etc.) sobem como "raw".
export function uploadChatAttachment(buffer: Buffer, mimeType: string, folder = "twisisa_market/chat") {
  if (!cloudinaryConfigured) throw new Error("CLOUDINARY_NOT_CONFIGURED");
  const isImage = mimeType.startsWith("image/");
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: isImage ? "image" : "raw",
        ...(isImage ? { transformation: [{ width: 1600, height: 1600, crop: "limit", quality: "auto" }] } : {})
      },
      (error, result) => error ? reject(error) : resolve((result ?? {}) as Record<string, unknown>)
    );
    stream.end(buffer);
  });
}

// Remove um ficheiro já ligado a um produto. Best-effort: se falhar, o registo na BD já foi apagado e fica só um órfão no Cloudinary.
export async function deleteCloudinaryAsset(publicId: string): Promise<void> {
  if (!cloudinaryConfigured) return;
  await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
}
