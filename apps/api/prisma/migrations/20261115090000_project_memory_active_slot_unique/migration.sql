-- Project Memory: PostgreSQL guarantees at most one ACTIVE rule per logical slot.
--
-- A slot is (provider, owner, repository, category, key, scope_fingerprint) within:
--   * a workspace, for shared rules            (workspace_id NOT NULL, visibility = 'workspace')
--   * a workspace + author, for personal rules (workspace_id NOT NULL, visibility = 'user')
--   * an author, for pre-workspace legacy rows (workspace_id IS NULL)
-- This mirrors ProjectMemoryService.persistMemory / update. The service keeps its per-repository
-- advisory lock; these indexes are the backstop for any write that bypasses it.
--
-- Partial indexes cannot be declared in schema.prisma (Prisma 6). They are owned by this
-- migration: if `prisma migrate dev` ever proposes dropping
-- project_memory_active_{workspace,personal,legacy}_slot_uidx, remove those lines.
--
-- Existing duplicates are resolved WITHOUT deleting data: per slot, the user-explicit rule wins
-- over learned ones, then the most recently updated; the others are marked 'superseded'
-- (exactly what the service does on conflict) and recorded in project_memory_dedup_audit with
-- their previous status, so the change is reviewable and reversible.
--
-- Idempotent (IF NOT EXISTS) so the dedup step can be re-run and tested in isolation.

-- Block concurrent writers between the dedup and the index build (released at commit).
LOCK TABLE "project_memories" IN SHARE ROW EXCLUSIVE MODE;

-- CreateTable
CREATE TABLE IF NOT EXISTS "project_memory_dedup_audit" (
    "id" BIGSERIAL NOT NULL,
    "memory_id" TEXT NOT NULL,
    "kept_memory_id" TEXT NOT NULL,
    "previous_status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_memory_dedup_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "project_memory_dedup_audit_memory_id_idx"
    ON "project_memory_dedup_audit"("memory_id");

-- Resolve existing duplicate active rows (same partitions as the indexes below).
WITH ranked AS (
    SELECT
        "id",
        "status",
        FIRST_VALUE("id") OVER slot AS "kept_id",
        ROW_NUMBER() OVER slot AS "rn"
    FROM "project_memories"
    WHERE "status" = 'active'
      AND ("workspace_id" IS NULL OR "visibility" IN ('workspace', 'user'))
    WINDOW slot AS (
        PARTITION BY
            CASE WHEN "workspace_id" IS NULL THEN 'legacy' ELSE "visibility" END,
            "workspace_id",
            CASE WHEN "workspace_id" IS NULL OR "visibility" = 'user' THEN "user_id" END,
            "provider", "owner", "repository", "category", "key", "scope_fingerprint"
        ORDER BY
            ("provenance_json" @> '[{"type":"user_explicit"}]'::jsonb) DESC,
            "updated_at" DESC,
            "created_at" DESC,
            "id" DESC
    )
)
INSERT INTO "project_memory_dedup_audit" ("memory_id", "kept_memory_id", "previous_status", "reason")
SELECT "id", "kept_id", "status", 'duplicate_active_slot'
FROM ranked
WHERE "rn" > 1;

UPDATE "project_memories" AS pm
SET "status" = 'superseded', "updated_at" = CURRENT_TIMESTAMP
FROM "project_memory_dedup_audit" AS audit
WHERE audit."memory_id" = pm."id"
  AND audit."reason" = 'duplicate_active_slot'
  AND pm."status" = 'active';

-- CreateIndex: shared workspace rules — one active per workspace slot.
CREATE UNIQUE INDEX IF NOT EXISTS "project_memory_active_workspace_slot_uidx"
    ON "project_memories"("workspace_id", "provider", "owner", "repository", "category", "key", "scope_fingerprint")
    WHERE "status" = 'active' AND "workspace_id" IS NOT NULL AND "visibility" = 'workspace';

-- CreateIndex: personal rules — one active per workspace + author slot.
CREATE UNIQUE INDEX IF NOT EXISTS "project_memory_active_personal_slot_uidx"
    ON "project_memories"("workspace_id", "user_id", "provider", "owner", "repository", "category", "key", "scope_fingerprint")
    WHERE "status" = 'active' AND "workspace_id" IS NOT NULL AND "visibility" = 'user';

-- CreateIndex: legacy pre-workspace rows — one active per author slot.
CREATE UNIQUE INDEX IF NOT EXISTS "project_memory_active_legacy_slot_uidx"
    ON "project_memories"("user_id", "provider", "owner", "repository", "category", "key", "scope_fingerprint")
    WHERE "status" = 'active' AND "workspace_id" IS NULL;
