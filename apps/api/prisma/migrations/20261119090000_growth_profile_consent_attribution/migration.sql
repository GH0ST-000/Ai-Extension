-- Optional growth profile, marketing consent evidence and first-touch attribution.
-- Additive only: nullable / defaulted columns on user_settings and two new tables.
-- Pre-existing index-name drift in other tables is intentionally NOT included here.

-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN     "marketing_consent_updated_at" TIMESTAMP(3),
ADD COLUMN     "marketing_email_consent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "primary_goal" TEXT,
ADD COLUMN     "professional_role" TEXT,
ADD COLUMN     "profile_completed_at" TIMESTAMP(3),
ADD COLUMN     "profile_skipped_at" TIMESTAMP(3),
ADD COLUMN     "usage_intent" TEXT;

-- CreateTable
CREATE TABLE "marketing_consent_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_acquisitions" (
    "user_id" TEXT NOT NULL,
    "signup_client" TEXT NOT NULL,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_content" TEXT,
    "referral" TEXT,
    "referrer_host" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_acquisitions_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "marketing_consent_events_user_id_created_at_idx" ON "marketing_consent_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "user_acquisitions_utm_source_created_at_idx" ON "user_acquisitions"("utm_source", "created_at");

-- AddForeignKey
ALTER TABLE "marketing_consent_events" ADD CONSTRAINT "marketing_consent_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_acquisitions" ADD CONSTRAINT "user_acquisitions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

