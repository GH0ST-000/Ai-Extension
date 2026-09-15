-- CreateTable
CREATE TABLE "github_app_installations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "account_login" TEXT NOT NULL,
    "account_type" TEXT NOT NULL,
    "repository_selection" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata_ciphertext" TEXT,
    "installed_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_app_installations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_app_installations_workspace_id_key" ON "github_app_installations"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_app_installations_installation_id_key" ON "github_app_installations"("installation_id");

-- CreateIndex
CREATE INDEX "github_app_installations_status_idx" ON "github_app_installations"("status");

-- AddForeignKey
ALTER TABLE "github_app_installations" ADD CONSTRAINT "github_app_installations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
