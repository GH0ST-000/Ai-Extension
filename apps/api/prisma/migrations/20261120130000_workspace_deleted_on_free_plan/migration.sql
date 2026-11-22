-- Decision B: records whether a workspace was on the free plan when its deletion started.
-- Additive, nullable (legacy deleted rows: NULL = counted as free). Apply after
-- 20261120120000_email_verification.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "deleted_on_free_plan" BOOLEAN;

