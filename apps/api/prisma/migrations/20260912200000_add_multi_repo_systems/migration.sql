-- CreateTable
CREATE TABLE "project_systems" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primary_provider" TEXT NOT NULL DEFAULT 'github',
    "primary_owner" TEXT NOT NULL,
    "primary_repository" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_systems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_system_repositories" (
    "id" TEXT NOT NULL,
    "system_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "owner" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'unknown',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'user_selected',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_system_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_relationships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "system_id" TEXT NOT NULL,
    "from_owner" TEXT NOT NULL,
    "from_repository" TEXT NOT NULL,
    "to_owner" TEXT NOT NULL,
    "to_repository" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "resource_kind" TEXT,
    "resource_key" TEXT,
    "confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "freshness_json" JSONB,
    "provenance_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_validated_at" TIMESTAMP(3),

    CONSTRAINT "repository_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_systems_user_id_idx" ON "project_systems"("user_id");

-- CreateIndex
CREATE INDEX "project_system_repositories_system_id_idx" ON "project_system_repositories"("system_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_system_repositories_system_id_provider_owner_repository_key" ON "project_system_repositories"("system_id", "provider", "owner", "repository");

-- CreateIndex
CREATE INDEX "repository_relationships_user_id_system_id_idx" ON "repository_relationships"("user_id", "system_id");

-- CreateIndex
CREATE INDEX "repository_relationships_system_id_type_status_idx" ON "repository_relationships"("system_id", "type", "status");

-- CreateIndex
CREATE INDEX "repository_relationships_system_id_from_owner_from_repository_idx" ON "repository_relationships"("system_id", "from_owner", "from_repository");

-- CreateIndex
CREATE INDEX "repository_relationships_system_id_to_owner_to_repository_idx" ON "repository_relationships"("system_id", "to_owner", "to_repository");

-- CreateIndex
CREATE INDEX "repository_relationships_system_id_resource_kind_resource_key_idx" ON "repository_relationships"("system_id", "resource_kind", "resource_key");

-- AddForeignKey
ALTER TABLE "project_systems" ADD CONSTRAINT "project_systems_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_system_repositories" ADD CONSTRAINT "project_system_repositories_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "project_systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_relationships" ADD CONSTRAINT "repository_relationships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_relationships" ADD CONSTRAINT "repository_relationships_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "project_systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;
