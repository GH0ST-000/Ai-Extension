-- Server-controlled AI usage reservations (billing hardening).
-- Existing rows keep their meaning: status defaults to 'committed'. A reservation is counted
-- immediately (quota cannot be oversubscribed) and is either committed or refunded; the
-- unique (workspace_id, in_flight_key) blocks one user's identical concurrent operation.
-- PostgreSQL allows many NULL in_flight_key values, so committed rows never conflict.

-- AlterTable
ALTER TABLE "workspace_usage_events" ADD COLUMN     "finalized_at" TIMESTAMP(3),
ADD COLUMN     "in_flight_key" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'committed',
ADD COLUMN     "user_id" TEXT;

-- CreateIndex
CREATE INDEX "workspace_usage_events_workspace_id_status_created_at_idx" ON "workspace_usage_events"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_usage_events_workspace_id_in_flight_key_key" ON "workspace_usage_events"("workspace_id", "in_flight_key");

