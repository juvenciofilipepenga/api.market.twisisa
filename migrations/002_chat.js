export const name = "002_chat.js";

export async function up(client) {
  await client.query(`
    ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPORT';
  `);
  await client.query(`
    CREATE TYPE "ConversationStatus" AS ENUM ('BOT','ESCALATED','CLOSED');
    CREATE TYPE "ChatSenderType" AS ENUM ('CUSTOMER','BOT','ADMIN');

    CREATE TABLE "Conversation" (
      "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "status" "ConversationStatus" NOT NULL DEFAULT 'BOT',
      "assignedAdminId" TEXT, "lastMessageAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "ChatMessage" (
      "id" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "senderType" "ChatSenderType" NOT NULL,
      "senderId" TEXT, "content" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "ChatAttachment" (
      "id" TEXT NOT NULL, "messageId" TEXT NOT NULL, "url" TEXT NOT NULL, "publicId" TEXT,
      "mimeType" TEXT NOT NULL, "sizeBytes" INTEGER NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ChatAttachment_pkey" PRIMARY KEY ("id")
    );

    CREATE INDEX "Conversation_userId_idx" ON "Conversation"("userId");
    CREATE INDEX "Conversation_status_lastMessageAt_idx" ON "Conversation"("status","lastMessageAt");
    CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId","createdAt");
    CREATE INDEX "ChatAttachment_messageId_idx" ON "ChatAttachment"("messageId");

    ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  `);
}

export async function down(client) {
  await client.query(`
    DROP TABLE "ChatAttachment", "ChatMessage", "Conversation" CASCADE;
    DROP TYPE "ChatSenderType", "ConversationStatus";
  `);
  // Nota: Postgres não permite remover um valor de um enum (SUPPORT fica em "NotificationType").
}
