-- Crear tabla para almacenar las suscripciones push
CREATE TABLE IF NOT EXISTS "PushSubscription" (
    "id" TEXT PRIMARY KEY,
    "endpoint" TEXT NOT NULL UNIQUE,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "PushSubscription_endpoint_idx" ON "PushSubscription"("endpoint");
