/** Soft limits for extracted page context (characters) — keep prompts cheap. */
export const MAX_SURROUNDING_TEXT_CHARS = 800;
export const MAX_SURROUNDING_CODE_CHARS = 1_200;
export const MAX_PAGE_DESCRIPTION_CHARS = 200;
export const MAX_TITLE_CHARS = 120;
export const MAX_URL_CHARS = 320;
export const MAX_PATH_CHARS = 200;
export const MAX_PR_BODY_CHARS = 600;

/** Day 9 — bounded multi-file PR Files tab extraction */
export const MAX_PR_CHANGED_FILES = 10;
export const MAX_PR_FILE_EXCERPT_CHARS = 800;
export const MAX_PR_FILE_LINES = 60;
export const MAX_PR_CHANGED_FILES_TOTAL_CHARS = 6_000;
