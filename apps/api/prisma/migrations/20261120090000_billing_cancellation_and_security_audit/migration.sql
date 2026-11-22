-- Security remediation (final audit): N-2/N-3/N-12 durable billing cancellation requests and
-- N-18 durable security audit events. Additive only: two new tables, no change to existing
-- columns or data. Safe to apply online; rollback = drop the two tables.

-- CreateTable
CREATE TABLE "billing_cancellation_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider_subscription_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_cancellation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_audit_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "workspace_id" TEXT,
    "actor_user_id_hash" TEXT,
    "request_id" TEXT,
    "detail" TEXT,
    "service" TEXT NOT NULL,
    "release" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_cancellation_requests_provider_subscription_id_key" ON "billing_cancellation_requests"("provider_subscription_id");

-- CreateIndex
CREATE INDEX "billing_cancellation_requests_status_next_attempt_at_idx" ON "billing_cancellation_requests"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "billing_cancellation_requests_workspace_id_status_idx" ON "billing_cancellation_requests"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "security_audit_events_workspace_id_created_at_idx" ON "security_audit_events"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "security_audit_events_type_created_at_idx" ON "security_audit_events"("type", "created_at");

-- AddForeignKey
ALTER TABLE "billing_cancellation_requests" ADD CONSTRAINT "billing_cancellation_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
