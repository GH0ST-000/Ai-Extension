-- Day 28: account-level onboarding preferences.
ALTER TABLE "user_settings" ADD COLUMN "onboarding_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "user_settings" ADD COLUMN "welcome_seen_at" TIMESTAMP(3);
ALTER TABLE "user_settings" ADD COLUMN "onboarding_dismissed_at" TIMESTAMP(3);
ALTER TABLE "user_settings" ADD COLUMN "first_value_at" TIMESTAMP(3);
ALTER TABLE "user_settings" ADD COLUMN "first_value_type" TEXT;
ALTER TABLE "user_settings" ADD COLUMN "dismissed_hint_ids" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "user_settings" ADD COLUMN "first_write_education_seen_at" TIMESTAMP(3);
