export const name = "015_chat_v2.js";

// Chat v2:
//  - ChatMessage.clientId: id gerado no browser; torna o envio idempotente (reenviar após falha de rede não duplica)
//    e deixa o cliente trocar a mensagem "pendente" local pela gravada, sem adivinhar.
//  - ChatMessage.readAt: quando o OUTRO lado viu a mensagem (visto / não visto).
//  - Conversation.customerTypingAt / adminTypingAt: "a escrever" guardado na BD (em serverless não há memória partilhada).
//  - Conversation.lastMessagePreview / lastMessageSender: pré-visualização da lista do admin sem uma query por conversa.
//  - User.lastSeenAt: presença (online) por batimento enquanto o chat está aberto.
//  - ChatAiSettings (linha única) e ChatKnowledge: o que o admin "treina" na IA (instruções + conhecimento da loja).
export async function up(client) {
  await client.query(`
    ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "clientId" TEXT;
    ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_conversationId_clientId_key" ON "ChatMessage"("conversationId", "clientId");
    CREATE INDEX IF NOT EXISTS "ChatMessage_conversationId_readAt_idx" ON "ChatMessage"("conversationId", "readAt");

    ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "customerTypingAt" TIMESTAMPTZ;
    ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "adminTypingAt" TIMESTAMPTZ;
    ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastMessagePreview" TEXT;
    ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastMessageSender" "ChatSenderType";

    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS "ChatAiSettings" (
      "id" TEXT NOT NULL DEFAULT 'default',
      "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
      "assistantName" TEXT NOT NULL DEFAULT 'Assistente Twisisa',
      "instructions" TEXT NOT NULL DEFAULT '',
      "updatedById" TEXT,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ChatAiSettings_pkey" PRIMARY KEY ("id")
    );

    CREATE TABLE IF NOT EXISTS "ChatKnowledge" (
      "id" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "active" BOOLEAN NOT NULL DEFAULT TRUE,
      "createdById" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ChatKnowledge_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX IF NOT EXISTS "ChatKnowledge_active_updatedAt_idx" ON "ChatKnowledge"("active", "updatedAt" DESC);
  `);
  // Mensagens anteriores a esta migração contam como vistas: senão o admin abria o painel com todo o histórico "por ler".
  await client.query(`UPDATE "ChatMessage" SET "readAt" = "createdAt" WHERE "readAt" IS NULL;`);
  // Pré-visualização das conversas que já existem.
  await client.query(`
    UPDATE "Conversation" c
    SET "lastMessagePreview" = LEFT(COALESCE(NULLIF(m."content", ''), '[Anexo]'), 140),
        "lastMessageSender" = m."senderType"
    FROM (
      SELECT DISTINCT ON ("conversationId") "conversationId", "content", "senderType"
      FROM "ChatMessage"
      ORDER BY "conversationId", "createdAt" DESC
    ) m
    WHERE m."conversationId" = c."id";
  `);
}

export async function down(client) {
  await client.query(`
    DROP TABLE IF EXISTS "ChatKnowledge";
    DROP TABLE IF EXISTS "ChatAiSettings";
    ALTER TABLE "User" DROP COLUMN IF EXISTS "lastSeenAt";
    ALTER TABLE "Conversation" DROP COLUMN IF EXISTS "lastMessageSender";
    ALTER TABLE "Conversation" DROP COLUMN IF EXISTS "lastMessagePreview";
    ALTER TABLE "Conversation" DROP COLUMN IF EXISTS "adminTypingAt";
    ALTER TABLE "Conversation" DROP COLUMN IF EXISTS "customerTypingAt";
    DROP INDEX IF EXISTS "ChatMessage_conversationId_readAt_idx";
    DROP INDEX IF EXISTS "ChatMessage_conversationId_clientId_key";
    ALTER TABLE "ChatMessage" DROP COLUMN IF EXISTS "readAt";
    ALTER TABLE "ChatMessage" DROP COLUMN IF EXISTS "clientId";
  `);
}
