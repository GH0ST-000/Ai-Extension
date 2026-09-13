-- Day 25 — SaaS workspaces, billing, usage, and resource workspace scoping.
-- Strategy: create workspace tables → nullable FKs → backfill → require NOT NULL where appropriate.

-- ---------------------------------------------------------------------------
-- 1) Workspace tenancy + billing tables
-- ---------------------------------------------------------------------------

CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");
CREATE INDEX "workspaces_status_idx" ON "workspaces"("status");

CREATE TABLE "workspace_memberships" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_memberships_workspace_id_user_id_key" ON "workspace_memberships"("workspace_id", "user_id");
CREATE INDEX "workspace_memberships_user_id_status_idx" ON "workspace_memberships"("user_id", "status");
CREATE INDEX "workspace_memberships_workspace_id_status_idx" ON "workspace_memberships"("workspace_id", "status");

CREATE TABLE "workspace_invitations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "invited_by_user_id" TEXT NOT NULL,
    "accepted_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_invitations_token_hash_key" ON "workspace_invitations"("token_hash");
CREATE INDEX "workspace_invitations_workspace_id_status_idx" ON "workspace_invitations"("workspace_id", "status");
CREATE INDEX "workspace_invitations_email_status_idx" ON "workspace_invitations"("email", "status");

CREATE TABLE "workspace_subscriptions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'paddle',
    "plan_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "billing_cycle" TEXT,
    "provider_customer_id" TEXT,
    "provider_subscription_id" TEXT,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_subscriptions_workspace_id_key" ON "workspace_subscriptions"("workspace_id");
CREATE INDEX "workspace_subscriptions_provider_subscription_id_idx" ON "workspace_subscriptions"("provider_subscription_id");

CREATE TABLE "billing_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_webhook_events_provider_event_id_key" ON "billing_webhook_events"("provider", "event_id");
CREATE INDEX "billing_webhook_events_provider_event_type_idx" ON "billing_webhook_events"("provider", "event_type");

CREATE TABLE "workspace_usage_counters" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_usage_counters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_usage_counters_workspace_id_metric_period_key_key" ON "workspace_usage_counters"("workspace_id", "metric", "period_key");

CREATE TABLE "workspace_usage_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_usage_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_usage_events_workspace_id_idempotency_key_key" ON "workspace_usage_events"("workspace_id", "idempotency_key");
CREATE INDEX "workspace_usage_events_workspace_id_metric_period_key_idx" ON "workspace_usage_events"("workspace_id", "metric", "period_key");

ALTER TABLE "users" ADD COLUMN "last_workspace_id" TEXT;

-- ---------------------------------------------------------------------------
-- 2) Nullable workspace columns on migrated resources
-- ---------------------------------------------------------------------------

ALTER TABLE "project_memories" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "project_memories" ADD COLUMN "created_by_user_id" TEXT;
ALTER TABLE "project_memories" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'workspace';

ALTER TABLE "project_systems" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "project_systems" ADD COLUMN "created_by_user_id" TEXT;

ALTER TABLE "repository_relationships" ADD COLUMN "workspace_id" TEXT;

ALTER TABLE "workflow_executions" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "workflow_audit_events" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "prompt_snapshots" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "execution_checkpoints" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "execution_failures" ADD COLUMN "workspace_id" TEXT;

-- ---------------------------------------------------------------------------
-- 3) Backfill personal workspace + OWNER membership + free subscription
-- ---------------------------------------------------------------------------

INSERT INTO "workspaces" ("id", "name", "slug", "status", "created_by_user_id", "created_at", "updated_at")
SELECT
    'ws_' || substr(md5(u."id" || ':personal'), 1, 24),
    CASE
        WHEN u."name" IS NOT NULL AND length(trim(u."name")) > 0
            THEN left(trim(u."name") || '''s Workspace', 80)
        WHEN position('@' in u."email") > 1
            THEN left(split_part(u."email", '@', 1) || '''s Workspace', 80)
        ELSE 'Personal Workspace'
    END,
    'personal-' || lower(substr(regexp_replace(u."id", '[^a-zA-Z0-9]', '', 'g'), 1, 16)),
    'active',
    u."id",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "users" u;

INSERT INTO "workspace_memberships" ("id", "workspace_id", "user_id", "role", "status", "joined_at", "created_at", "updated_at")
SELECT
    'wm_' || substr(md5(u."id" || ':owner'), 1, 24),
    'ws_' || substr(md5(u."id" || ':personal'), 1, 24),
    u."id",
    'owner',
    'active',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "users" u;

INSERT INTO "workspace_subscriptions" ("id", "workspace_id", "provider", "plan_id", "status", "cancel_at_period_end", "created_at", "updated_at")
SELECT
    'wsub_' || substr(md5(u."id" || ':sub'), 1, 24),
    'ws_' || substr(md5(u."id" || ':personal'), 1, 24),
    'paddle',
    'free',
    'active',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "users" u;

UPDATE "users" u
SET "last_workspace_id" = 'ws_' || substr(md5(u."id" || ':personal'), 1, 24);

-- ---------------------------------------------------------------------------
-- 4) Backfill workspace_id on resources
-- ---------------------------------------------------------------------------

UPDATE "project_memories" pm
SET
    "workspace_id" = 'ws_' || substr(md5(pm."user_id" || ':personal'), 1, 24),
    "created_by_user_id" = pm."user_id",
    "visibility" = CASE WHEN pm."category" = 'USER_PREFERENCE' THEN 'user' ELSE 'workspace' END;

UPDATE "project_systems" ps
SET
    "workspace_id" = 'ws_' || substr(md5(ps."user_id" || ':personal'), 1, 24),
    "created_by_user_id" = ps."user_id";

UPDATE "repository_relationships" rr
SET "workspace_id" = 'ws_' || substr(md5(rr."user_id" || ':personal'), 1, 24);

UPDATE "workflow_executions" we
SET "workspace_id" = 'ws_' || substr(md5(we."user_id" || ':personal'), 1, 24);

UPDATE "workflow_audit_events" wae
SET "workspace_id" = 'ws_' || substr(md5(wae."user_id" || ':personal'), 1, 24);

UPDATE "prompt_snapshots" psnp
SET "workspace_id" = 'ws_' || substr(md5(psnp."user_id" || ':personal'), 1, 24);

UPDATE "execution_checkpoints" ec
SET "workspace_id" = 'ws_' || substr(md5(ec."user_id" || ':personal'), 1, 24);

UPDATE "execution_failures" ef
SET "workspace_id" = 'ws_' || substr(md5(ef."user_id" || ':personal'), 1, 24);

-- ---------------------------------------------------------------------------
-- 5) Require workspace_id where appropriate
--    ProjectMemory keeps workspace_id nullable so USER_PREFERENCE can remain
--    user-scoped; non-preference rows are backfilled above.
-- ---------------------------------------------------------------------------

ALTER TABLE "project_systems" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "repository_relationships" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "workflow_executions" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "workflow_audit_events" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "prompt_snapshots" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "execution_checkpoints" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "execution_failures" ALTER COLUMN "workspace_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 6) Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "users" ADD CONSTRAINT "users_last_workspace_id_fkey"
    FOREIGN KEY ("last_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_user_id_fkey"
    FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_by_user_id_fkey"
    FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workspace_usage_counters" ADD CONSTRAINT "workspace_usage_counters_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workspace_usage_events" ADD CONSTRAINT "workspace_usage_events_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_systems" ADD CONSTRAINT "project_systems_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_systems" ADD CONSTRAINT "project_systems_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "repository_relationships" ADD CONSTRAINT "repository_relationships_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_audit_events" ADD CONSTRAINT "workflow_audit_events_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prompt_snapshots" ADD CONSTRAINT "prompt_snapshots_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "execution_checkpoints" ADD CONSTRAINT "execution_checkpoints_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "execution_failures" ADD CONSTRAINT "execution_failures_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 7) Indexes + unique constraint updates for workspace scoping
-- ---------------------------------------------------------------------------

CREATE INDEX "project_memory_ws_repo_status_idx" ON "project_memories"("workspace_id", "owner", "repository", "status");
CREATE INDEX "project_memory_ws_repo_category_idx" ON "project_memories"("workspace_id", "owner", "repository", "category");
CREATE INDEX "project_memory_ws_repo_key_idx" ON "project_memories"("workspace_id", "owner", "repository", "key");
CREATE INDEX "project_memory_ws_lookup_idx" ON "project_memories"("workspace_id", "provider", "owner", "repository", "category", "key", "scope_fingerprint");

CREATE INDEX "project_systems_workspace_id_idx" ON "project_systems"("workspace_id");
CREATE INDEX "repository_relationships_workspace_id_system_id_idx" ON "repository_relationships"("workspace_id", "system_id");

DROP INDEX IF EXISTS "workflow_executions_user_id_workflow_id_execution_number_key";
CREATE UNIQUE INDEX "workflow_executions_workspace_id_workflow_id_execution_number_key"
    ON "workflow_executions"("workspace_id", "workflow_id", "execution_number");
CREATE INDEX "workflow_executions_workspace_id_started_at_idx" ON "workflow_executions"("workspace_id", "started_at");
CREATE INDEX "workflow_executions_workspace_id_workflow_id_idx" ON "workflow_executions"("workspace_id", "workflow_id");
CREATE INDEX "workflow_executions_workspace_id_status_idx" ON "workflow_executions"("workspace_id", "status");

CREATE INDEX "workflow_audit_events_workspace_id_workflow_id_idx" ON "workflow_audit_events"("workspace_id", "workflow_id");

DROP INDEX IF EXISTS "prompt_snapshots_user_id_name_hash_key";
CREATE UNIQUE INDEX "prompt_snapshots_workspace_id_name_hash_key" ON "prompt_snapshots"("workspace_id", "name", "hash");
CREATE INDEX "prompt_snapshots_workspace_id_name_version_idx" ON "prompt_snapshots"("workspace_id", "name", "version");

CREATE INDEX "execution_checkpoints_workspace_id_execution_id_idx" ON "execution_checkpoints"("workspace_id", "execution_id");
CREATE INDEX "execution_failures_workspace_id_category_idx" ON "execution_failures"("workspace_id", "category");
