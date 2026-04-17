ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "clientToken" TEXT;
CREATE INDEX IF NOT EXISTS "PushSubscription_clientToken_idx" ON "PushSubscription"("clientToken");
