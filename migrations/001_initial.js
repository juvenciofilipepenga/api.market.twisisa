export const name = "001_initial.js";

export async function up(client) {
  await client.query(`
    CREATE TYPE "UserStatus" AS ENUM ('PENDING','ACTIVE','SUSPENDED','BLOCKED');
    CREATE TYPE "RoleName" AS ENUM ('CUSTOMER','ADMIN','SUPER_ADMIN');
    CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT','PAYMENT_REVIEW','PAID','PROCESSING','READY_FOR_SHIPMENT','SHIPPED','OUT_FOR_DELIVERY','DELIVERED','CANCELLATION_REQUESTED','CANCELLED','REFUND_PENDING','REFUNDED');
    CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED','AUTHENTICATING','SUCCESS','FAILED','TIMEOUT','PENDING_CONFIRMATION','CANCELLED','REFUNDED','PAYMENT_PENDING','PROOF_SUBMITTED','UNDER_REVIEW','PAYMENT_CONFIRMED','PAYMENT_REJECTED','REFUND_PENDING','REFUNDED_LEGACY');
    CREATE TYPE "NotificationType" AS ENUM ('ORDER','PAYMENT','DELIVERY','SECURITY','MARKETING','SYSTEM','REFERRAL');

    CREATE TABLE "User" (
      "id" TEXT NOT NULL, "email" TEXT NOT NULL, "phone" TEXT, "passwordHash" TEXT NOT NULL, "name" TEXT NOT NULL,
      "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE', "referralCode" TEXT NOT NULL, "referredById" TEXT,
      "completedReferrals" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "User_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "Role" (
      "id" TEXT NOT NULL, "name" "RoleName" NOT NULL, CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "UserRole" (
      "userId" TEXT NOT NULL, "roleId" TEXT NOT NULL, CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
    );
    CREATE TABLE "Session" (
      "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "expiresAt" TIMESTAMPTZ NOT NULL,
      "revokedAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "Category" (
      "id" TEXT NOT NULL, "name" TEXT NOT NULL, "slug" TEXT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "Product" (
      "id" TEXT NOT NULL, "name" TEXT NOT NULL, "slug" TEXT NOT NULL, "description" TEXT, "priceMzn" DECIMAL(12,2) NOT NULL,
      "stock" INTEGER NOT NULL DEFAULT 0, "active" BOOLEAN NOT NULL DEFAULT true, "categoryId" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "ProductImage" (
      "id" TEXT NOT NULL, "productId" TEXT NOT NULL, "url" TEXT NOT NULL, "publicId" TEXT, "altText" TEXT,
      "sortOrder" INTEGER NOT NULL DEFAULT 0, "isPrimary" BOOLEAN NOT NULL DEFAULT false, CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "Order" (
      "id" TEXT NOT NULL, "orderNumber" TEXT NOT NULL, "userId" TEXT NOT NULL, "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
      "subtotalMzn" DECIMAL(12,2) NOT NULL, "shippingMzn" DECIMAL(12,2) NOT NULL, "discountMzn" DECIMAL(12,2) NOT NULL,
      "totalMzn" DECIMAL(12,2) NOT NULL, "cancellationReason" TEXT, "cancelledAt" TIMESTAMPTZ, "cancelledById" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "OrderItem" (
      "id" TEXT NOT NULL, "orderId" TEXT NOT NULL, "productId" TEXT NOT NULL, "productName" TEXT NOT NULL,
      "unitPriceMzn" DECIMAL(12,2) NOT NULL, "quantity" INTEGER NOT NULL, "subtotalMzn" DECIMAL(12,2) NOT NULL,
      CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "OrderStatusHistory" (
      "id" TEXT NOT NULL, "orderId" TEXT NOT NULL, "from" "OrderStatus", "to" "OrderStatus" NOT NULL, "reason" TEXT,
      "actorId" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "Payment" (
      "id" TEXT NOT NULL, "orderId" TEXT NOT NULL, "provider" TEXT NOT NULL, "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
      "amountMzn" DECIMAL(12,2) NOT NULL, "paymentNumber" TEXT, "reference" TEXT NOT NULL, "transactionCode" TEXT, "proofUrl" TEXT,
      "method" TEXT, "providerPaymentId" TEXT, "failureCode" TEXT, "failureMessage" TEXT, "authenticatedAt" TIMESTAMPTZ,
      "confirmedAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "Invoice" (
      "id" TEXT NOT NULL, "invoiceNumber" TEXT NOT NULL, "orderId" TEXT NOT NULL, "userId" TEXT NOT NULL,
      "customerName" TEXT NOT NULL, "customerEmail" TEXT NOT NULL, "customerPhone" TEXT, "subtotalMzn" DECIMAL(12,2) NOT NULL,
      "shippingMzn" DECIMAL(12,2) NOT NULL, "discountMzn" DECIMAL(12,2) NOT NULL, "totalMzn" DECIMAL(12,2) NOT NULL,
      "paymentMethod" TEXT, "paymentReference" TEXT, "pdfUrl" TEXT, "issuedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "Address" (
      "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "label" TEXT NOT NULL, "address1" TEXT NOT NULL, "city" TEXT NOT NULL,
      "province" TEXT NOT NULL, "postalCode" TEXT, "phone" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "Notification" (
      "id" TEXT NOT NULL, "userId" TEXT, "type" "NotificationType" NOT NULL, "title" TEXT NOT NULL, "message" TEXT NOT NULL,
      "data" JSONB, "readAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "AuditLog" (
      "id" TEXT NOT NULL, "actorId" TEXT, "action" TEXT NOT NULL, "entity" TEXT NOT NULL, "entityId" TEXT, "ip" TEXT,
      "userAgent" TEXT, "metadata" JSONB, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
    CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
    CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");
    CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");
    CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
    CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");
    CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");
    CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");
    CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");
    CREATE UNIQUE INDEX "Payment_reference_key" ON "Payment"("reference");
    CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");
    CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");

    CREATE INDEX "User_referredById_idx" ON "User"("referredById");
    CREATE INDEX "Session_userId_idx" ON "Session"("userId");
    CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");
    CREATE INDEX "Product_active_idx" ON "Product"("active");
    CREATE INDEX "ProductImage_productId_sortOrder_idx" ON "ProductImage"("productId","sortOrder");
    CREATE INDEX "Order_userId_idx" ON "Order"("userId");
    CREATE INDEX "Order_status_idx" ON "Order"("status");
    CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");
    CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
    CREATE INDEX "OrderStatusHistory_orderId_createdAt_idx" ON "OrderStatusHistory"("orderId","createdAt");
    CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");
    CREATE INDEX "Payment_status_idx" ON "Payment"("status");
    CREATE INDEX "Payment_providerPaymentId_idx" ON "Payment"("providerPaymentId");
    CREATE INDEX "Invoice_userId_idx" ON "Invoice"("userId");
    CREATE INDEX "Address_userId_idx" ON "Address"("userId");
    CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId","createdAt");
    CREATE INDEX "Notification_readAt_idx" ON "Notification"("readAt");
    CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");
    CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity","entityId");
    CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

    ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON UPDATE CASCADE;
    ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON UPDATE CASCADE;
    ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON UPDATE CASCADE;
    ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON UPDATE CASCADE;
    ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  `);
}

export async function down(client) {
  await client.query(`
    DROP TABLE "AuditLog", "Notification", "Address", "Invoice", "Payment", "OrderStatusHistory", "OrderItem", "Order", "ProductImage", "Product", "Category", "Session", "UserRole", "Role", "User" CASCADE;
    DROP TYPE "NotificationType", "PaymentStatus", "OrderStatus", "RoleName", "UserStatus";
  `);
}
