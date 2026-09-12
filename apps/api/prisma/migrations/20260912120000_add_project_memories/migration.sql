-- CreateTable
CREATE TABLE "project_memories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "owner" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "scope_json" JSONB NOT NULL,
    "freshness_json" JSONB,
    "provenance_json" JSONB NOT NULL,
    "scope_fingerprint" TEXT NOT NULL,
    "supersedes_memory_id" TEXT,
    "disputed_fingerprint" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_confirmed_at" TIMESTAMP(3),

    CONSTRAINT "project_memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_memory_user_repo_status_idx" ON "project_memories"("user_id", "owner", "repository", "status");

-- CreateIndex
CREATE INDEX "project_memory_user_repo_category_idx" ON "project_memories"("user_id", "owner", "repository", "category");

-- CreateIndex
CREATE INDEX "project_memory_user_repo_key_idx" ON "project_memories"("user_id", "owner", "repository", "key");

-- CreateIndex
CREATE INDEX "project_memory_lookup_idx" ON "project_memories"("user_id", "provider", "owner", "repository", "category", "key", "scope_fingerprint");

-- AddForeignKey
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
