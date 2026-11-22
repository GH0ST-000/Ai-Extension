-- F-02 / F-23: bind provider subscriptions to checkouts this server started.
-- F-03: count confirmed "not found" answers separately from other cancellation failures.
-- Additive only: one new table, one new column with a default. No existing row is changed.
-- Apply AFTER 20261120130000_workspace_deleted_on_free_plan (timestamp order).

-- AlterTable
ALTER TABLE "billing_cancellation_requests" ADD COLUMN     "not_found_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "billing_checkouts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "billing_cycle" TEXT NOT NULL,
    "provider_transaction_id" TEXT,
    "checkout_url" TEXT,
    "provider_subscription_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "subscription_status" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkouts_provider_subscription_id_key" ON "billing_checkouts"("provider_subscription_id");

-- CreateIndex
CREATE INDEX "billing_checkouts_workspace_id_status_created_at_idx" ON "billing_checkouts"("workspace_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
