-- Day 24 — Reliability Engine tables

CREATE TABLE "prompt_snapshots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "capability" TEXT,
    "action" TEXT,
    "body" TEXT NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "redacted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_executions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "execution_number" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "health_score" INTEGER NOT NULL DEFAULT 100,
    "health_band" TEXT NOT NULL DEFAULT 'Excellent',
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "parent_execution_id" TEXT,
    "goal" TEXT,
    "context_version_json" JSONB NOT NULL,
    "snapshot_json" JSONB,
    "lineage_json" JSONB,
    "health_signals_json" JSONB,
    "ai_requests_json" JSONB,
    "prompt_snapshot_id" TEXT,
    "resume_available" BOOLEAN NOT NULL DEFAULT false,
    "replay_available" BOOLEAN NOT NULL DEFAULT true,
    "artifact_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_executions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_audit_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "step_id" TEXT,
    "artifact_id" TEXT,
    "message" TEXT,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "execution_checkpoints" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "step_id" TEXT,
    "state_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "execution_failures" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "retryable" BOOLEAN NOT NULL,
    "user_message" TEXT NOT NULL,
    "technical_reason" TEXT NOT NULL,
    "stage" TEXT,
    "code" TEXT,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_failures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prompt_snapshots_user_id_name_hash_key" ON "prompt_snapshots"("user_id", "name", "hash");
CREATE INDEX "prompt_snapshots_user_id_name_version_idx" ON "prompt_snapshots"("user_id", "name", "version");

CREATE UNIQUE INDEX "workflow_executions_user_id_workflow_id_execution_number_key" ON "workflow_executions"("user_id", "workflow_id", "execution_number");
CREATE INDEX "workflow_executions_user_id_started_at_idx" ON "workflow_executions"("user_id", "started_at");
CREATE INDEX "workflow_executions_user_id_workflow_id_idx" ON "workflow_executions"("user_id", "workflow_id");
CREATE INDEX "workflow_executions_user_id_status_idx" ON "workflow_executions"("user_id", "status");

CREATE INDEX "workflow_audit_events_execution_id_timestamp_idx" ON "workflow_audit_events"("execution_id", "timestamp");
CREATE INDEX "workflow_audit_events_user_id_workflow_id_idx" ON "workflow_audit_events"("user_id", "workflow_id");

CREATE INDEX "execution_checkpoints_execution_id_created_at_idx" ON "execution_checkpoints"("execution_id", "created_at");
CREATE INDEX "execution_checkpoints_user_id_execution_id_idx" ON "execution_checkpoints"("user_id", "execution_id");

CREATE INDEX "execution_failures_execution_id_created_at_idx" ON "execution_failures"("execution_id", "created_at");
CREATE INDEX "execution_failures_user_id_category_idx" ON "execution_failures"("user_id", "category");

ALTER TABLE "prompt_snapshots" ADD CONSTRAINT "prompt_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_prompt_snapshot_id_fkey" FOREIGN KEY ("prompt_snapshot_id") REFERENCES "prompt_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "workflow_audit_events" ADD CONSTRAINT "workflow_audit_events_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "execution_checkpoints" ADD CONSTRAINT "execution_checkpoints_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "execution_failures" ADD CONSTRAINT "execution_failures_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
