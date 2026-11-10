-- Paddle does not guarantee webhook order; track the last applied provider state.
ALTER TABLE "workspace_subscriptions" ADD COLUMN "provider_updated_at" TIMESTAMP(3);
