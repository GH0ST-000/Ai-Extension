export type ParsedSuggestFix = {
  issue: string | null;
  why: string | null;
  note: string | null;
  /** Remaining prose that is not Issue/Why/Note. */
  prose: string;
  language: string | null;
  /** Corrected snippet from the best fenced code block, if any. */
  fixCode: string | null;
};

type FenceMatch = {
  index: number;
  length: number;
  language: string | null;
  body: string;
};

const FENCE_RE = /```([^\n`]*)\r?\n([\s\S]*?)```/g;

const META_LINE_RE = /^(issue|why|note)\s*:\s*(.+)$/i;

function collectFences(content: string): FenceMatch[] {
  const fences: FenceMatch[] = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(content)) !== null) {
    const language = match[1]?.trim() || null;
    const body = (match[2] ?? '').replace(/\n$/, '');
    fences.push({
      index: match.index,
      length: match[0].length,
      language,
      body,
    });
  }
  return fences;
}

function looksLikeMetaBlock(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) {
    return true;
  }
  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return true;
  }
  const metaLines = lines.filter((line) => META_LINE_RE.test(line)).length;
  return metaLines >= Math.ceil(lines.length / 2);
}

function scoreFence(fence: FenceMatch): number {
  let score = fence.body.trim().length;
  if (fence.language) {
    score += 1000;
  }
  if (looksLikeMetaBlock(fence.body)) {
    score -= 5000;
  }
  // Prefer code-ish signals.
  if (/[{};=<>]|::|->|function\b|const\b|class\b|Route::/.test(fence.body)) {
    score += 200;
  }
  return score;
}

function pickBestFence(fences: FenceMatch[]): FenceMatch | null {
  if (fences.length === 0) {
    return null;
  }
  let best = fences[0]!;
  let bestScore = scoreFence(best);
  for (const fence of fences.slice(1)) {
    const score = scoreFence(fence);
    if (score > bestScore) {
      best = fence;
      bestScore = score;
    }
  }
  if (!best.body.trim() || (looksLikeMetaBlock(best.body) && !best.language)) {
    // Still accept language-tagged meta-looking blocks only if nothing better.
    const withLang = fences.find((fence) => fence.language && fence.body.trim());
    return withLang ?? (best.body.trim() ? best : null);
  }
  return best;
}

function parseMetaFields(prose: string): {
  issue: string | null;
  why: string | null;
  note: string | null;
  rest: string;
} {
  let issue: string | null = null;
  let why: string | null = null;
  let note: string | null = null;
  const restLines: string[] = [];

  for (const rawLine of prose.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = META_LINE_RE.exec(line);
    if (!match) {
      restLines.push(rawLine);
      continue;
    }
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === 'issue' && !issue) {
      issue = value;
    } else if (key === 'why' && !why) {
      why = value;
    } else if (key === 'note' && !note) {
      note = value;
    } else {
      restLines.push(rawLine);
    }
  }

  return {
    issue,
    why,
    note,
    rest: restLines.join('\n').trim(),
  };
}

/**
 * Extract a safe patch preview from Suggest Fix streaming text.
 * Prefers a language-tagged code fence over meta-looking fences.
 */
export function parseSuggestFixContent(content: string): ParsedSuggestFix {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      issue: null,
      why: null,
      note: null,
      prose: '',
      language: null,
      fixCode: null,
    };
  }

  const fences = collectFences(trimmed);
  const best = pickBestFence(fences);

  let proseSource = trimmed;
  let language: string | null = null;
  let fixCode: string | null = null;

  if (best) {
    language = best.language;
    fixCode = best.body.trim().length > 0 ? best.body : null;

    // Keep text from non-chosen fences (often Issue/Why wrapped in ```) as prose.
    const discardedMeta: string[] = [];
    for (const fence of fences) {
      if (fence.index === best.index) {
        continue;
      }
      if (fence.body.trim()) {
        discardedMeta.push(fence.body.trim());
      }
    }

    proseSource = [
      trimmed.slice(0, best.index).trim(),
      ...discardedMeta,
      trimmed.slice(best.index + best.length).trim(),
    ]
      .filter(Boolean)
      .join('\n')
      .trim();

    // Drop any remaining raw fence markers from prose.
    proseSource = proseSource.replace(FENCE_RE, '').trim();
  }

  const meta = parseMetaFields(proseSource);

  return {
    issue: meta.issue,
    why: meta.why,
    note: meta.note,
    prose: meta.rest,
    language,
    fixCode,
  };
}

/** Clipboard payload for Copy Fix — fence body when present, else full text. */
export function extractFixClipboardText(content: string): string {
  const parsed = parseSuggestFixContent(content);
  return parsed.fixCode?.trim() || content.trim();
}
