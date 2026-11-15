-- Project Memory audit log (additive: one new table; no existing data touched).
-- Pre-existing index-name drift in other tables is intentionally NOT included here.

-- CreateTable
CREATE TABLE "project_memory_audit_events" (
    "id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "workspace_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "related_memory_id" TEXT,
    "event_type" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_name" TEXT,
    "reason" TEXT,
    "visibility" TEXT NOT NULL,
    "subject_user_id" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "owner" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "previous_state" JSONB,
    "new_state" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_memory_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_memory_audit_events_workspace_id_created_at_id_idx" ON "project_memory_audit_events"("workspace_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "project_memory_audit_events_workspace_id_memory_id_created__idx" ON "project_memory_audit_events"("workspace_id", "memory_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "project_memory_audit_events_workspace_id_actor_user_id_crea_idx" ON "project_memory_audit_events"("workspace_id", "actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "project_memory_audit_events_workspace_id_event_type_created_idx" ON "project_memory_audit_events"("workspace_id", "event_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "project_memory_audit_events_workspace_id_owner_repository_c_idx" ON "project_memory_audit_events"("workspace_id", "owner", "repository", "created_at" DESC);

-- CreateIndex
CREATE INDEX "project_memory_audit_events_actor_user_id_idx" ON "project_memory_audit_events"("actor_user_id");

-- AddForeignKey
ALTER TABLE "project_memory_audit_events" ADD CONSTRAINT "project_memory_audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memory_audit_events" ADD CONSTRAINT "project_memory_audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Append-only enforcement. Normal application code never updates or deletes audit rows.
-- Permitted exceptions are the two foreign-key actions:
--   * UPDATE that only sets actor_user_id to NULL (the actor's account was deleted);
--   * DELETE of rows whose workspace no longer exists (workspace deletion cascade).
-- Limits: a database owner/superuser can still disable triggers, TRUNCATE or drop the table;
-- this is tamper *resistance* for application paths, not a cryptographic guarantee.
CREATE OR REPLACE FUNCTION project_memory_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL
       AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'project_memory_audit_events is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_memory_audit_events_append_only
  BEFORE UPDATE OR DELETE ON "project_memory_audit_events"
  FOR EACH ROW EXECUTE FUNCTION project_memory_audit_events_append_only();
