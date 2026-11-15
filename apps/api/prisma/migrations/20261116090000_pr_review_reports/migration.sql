-- Persistent PR review history (additive: new table only; no existing data touched).
-- Pre-existing index-name drift in other tables is intentionally NOT included here.

-- CreateTable
CREATE TABLE "pr_review_reports" (
    "id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT,
    "operation_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "owner" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "pull_request_number" INTEGER NOT NULL,
    "pull_request_title" TEXT,
    "head_sha" TEXT,
    "base_branch" TEXT,
    "head_branch" TEXT,
    "status" TEXT NOT NULL,
    "failure_code" TEXT,
    "risk_level" TEXT,
    "diff_source" TEXT,
    "findings_count" INTEGER NOT NULL DEFAULT 0,
    "needs_investigation_count" INTEGER NOT NULL DEFAULT 0,
    "files_total" INTEGER,
    "files_reviewed" INTEGER NOT NULL DEFAULT 0,
    "coverage_complete" BOOLEAN NOT NULL DEFAULT false,
    "memory_mode" TEXT,
    "memory_status" TEXT,
    "snapshot" JSONB NOT NULL,
    "report_markdown" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_review_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pr_review_reports_workspace_id_created_at_id_idx" ON "pr_review_reports"("workspace_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "pr_review_reports_workspace_id_owner_repository_pull_reques_idx" ON "pr_review_reports"("workspace_id", "owner", "repository", "pull_request_number", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pr_review_reports_workspace_id_status_created_at_idx" ON "pr_review_reports"("workspace_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pr_review_reports_user_id_idx" ON "pr_review_reports"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pr_review_reports_workspace_id_operation_id_key" ON "pr_review_reports"("workspace_id", "operation_id");

-- AddForeignKey
ALTER TABLE "pr_review_reports" ADD CONSTRAINT "pr_review_reports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_review_reports" ADD CONSTRAINT "pr_review_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Snapshots are immutable: the only permitted UPDATE is the FK action that detaches a
-- deleted initiator (user_id -> NULL). Rows are removed only by workspace deletion (cascade).
CREATE OR REPLACE FUNCTION pr_review_reports_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.user_id IS NULL AND OLD.user_id IS NOT NULL
     AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pr_review_reports rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pr_review_reports_immutable
  BEFORE UPDATE ON "pr_review_reports"
  FOR EACH ROW EXECUTE FUNCTION pr_review_reports_immutable();
