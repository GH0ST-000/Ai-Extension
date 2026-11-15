-- AI operation lifecycle: leases (heartbeat), delivery marker, and a short-lived result
-- copy for lost-response retries. All columns nullable: existing rows are unaffected.
-- Reservations created before this migration (lease_expires_at NULL) are recovered by age.

-- AlterTable
ALTER TABLE "workspace_usage_events" ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "lease_expires_at" TIMESTAMP(3),
ADD COLUMN     "request_key" TEXT,
ADD COLUMN     "result_expires_at" TIMESTAMP(3),
ADD COLUMN     "result_meta" JSONB,
ADD COLUMN     "result_text" TEXT;

-- CreateIndex
CREATE INDEX "workspace_usage_events_status_lease_expires_at_idx" ON "workspace_usage_events"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "workspace_usage_events_workspace_id_result_expires_at_idx" ON "workspace_usage_events"("workspace_id", "result_expires_at");

