import {
  JIRA_MAX_COMMENT_CHARS,
  JIRA_MAX_COMMENTS,
  JIRA_MAX_DESCRIPTION_CHARS,
  type JiraRichTextNormalized,
} from '@project-x/types';

type AdfNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
};

function truncatePlain(text: string, max: number): JiraRichTextNormalized {
  if (text.length <= max) {
    return { plainText: text, truncated: false };
  }
  return { plainText: `${text.slice(0, max)}…`, truncated: true };
}

/**
 * Convert Atlassian Document Format (or plain string) to safe plain text.
 * Does not preserve HTML; unsupported nodes are skipped.
 */
export function normalizeJiraRichText(
  value: unknown,
  maxChars = JIRA_MAX_DESCRIPTION_CHARS,
): JiraRichTextNormalized {
  if (value == null) {
    return { plainText: '', truncated: false };
  }
  if (typeof value === 'string') {
    return truncatePlain(value.replace(/\s+/g, ' ').trim(), maxChars);
  }
  if (typeof value !== 'object') {
    return { plainText: '', truncated: false };
  }

  const lines: string[] = [];
  walkAdf(value as AdfNode, lines, 0);
  const joined = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncatePlain(joined, maxChars);
}

function walkAdf(node: AdfNode, lines: string[], depth: number): void {
  const type = node.type ?? '';
  switch (type) {
    case 'doc':
      for (const child of node.content ?? []) {
        walkAdf(child, lines, depth);
      }
      return;
    case 'paragraph':
    case 'heading': {
      const parts: string[] = [];
      collectInline(node, parts);
      const prefix =
        type === 'heading' ? `${'#'.repeat(Math.min(Number(node.attrs?.level) || 1, 3))} ` : '';
      const text = parts.join('').trim();
      if (text) {
        lines.push(`${prefix}${text}`);
      }
      lines.push('');
      return;
    }
    case 'bulletList':
    case 'orderedList': {
      let index = 1;
      for (const item of node.content ?? []) {
        const parts: string[] = [];
        collectInline(item, parts);
        const text = parts.join('').trim();
        if (text) {
          lines.push(type === 'orderedList' ? `${index}. ${text}` : `- ${text}`);
          index += 1;
        }
        for (const nested of item.content ?? []) {
          if (nested.type === 'bulletList' || nested.type === 'orderedList') {
            walkAdf(nested, lines, depth + 1);
          }
        }
      }
      lines.push('');
      return;
    }
    case 'codeBlock': {
      const parts: string[] = [];
      collectInline(node, parts);
      const code = parts.join('');
      lines.push('```');
      lines.push(code);
      lines.push('```');
      lines.push('');
      return;
    }
    case 'blockquote': {
      const start = lines.length;
      for (const child of node.content ?? []) {
        walkAdf(child, lines, depth);
      }
      for (let i = start; i < lines.length; i += 1) {
        if (lines[i]) {
          lines[i] = `> ${lines[i]}`;
        }
      }
      return;
    }
    case 'table': {
      for (const row of (node.content ?? []).slice(0, 20)) {
        const cells: string[] = [];
        for (const cell of (row.content ?? []).slice(0, 10)) {
          const parts: string[] = [];
          collectInline(cell, parts);
          cells.push(parts.join('').trim());
        }
        if (cells.some(Boolean)) {
          lines.push(`| ${cells.join(' | ')} |`);
        }
      }
      lines.push('');
      return;
    }
    case 'rule':
      lines.push('---');
      return;
    case 'mediaSingle':
    case 'media':
    case 'mediaGroup':
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      lines.push('[attachment/media omitted]');
      return;
    default:
      if (node.content) {
        for (const child of node.content) {
          walkAdf(child, lines, depth);
        }
      }
  }
}

function collectInline(node: AdfNode, parts: string[]): void {
  if (node.type === 'text' && typeof node.text === 'string') {
    let text = node.text;
    const marks = node.marks ?? [];
    const code = marks.some((m) => m.type === 'code');
    const link = marks.find((m) => m.type === 'link');
    if (code) {
      text = `\`${text}\``;
    }
    if (link?.attrs?.href && typeof link.attrs.href === 'string') {
      text = `[${text}](${link.attrs.href})`;
    }
    parts.push(text);
    return;
  }
  if (node.type === 'hardBreak') {
    parts.push('\n');
    return;
  }
  if (node.type === 'mention' && typeof node.attrs?.text === 'string') {
    parts.push(String(node.attrs.text));
    return;
  }
  if (node.type === 'emoji' && typeof node.attrs?.shortName === 'string') {
    parts.push(String(node.attrs.shortName));
    return;
  }
  for (const child of node.content ?? []) {
    collectInline(child, parts);
  }
}

export function boundComments(
  comments: Array<{
    id: string;
    author?: string;
    createdAt?: string;
    body: JiraRichTextNormalized;
  }>,
): {
  comments: Array<{
    id: string;
    author?: string;
    createdAt?: string;
    body: JiraRichTextNormalized;
  }>;
  truncated: boolean;
} {
  const limited = comments.slice(-JIRA_MAX_COMMENTS);
  const slice = limited.map((c) => {
    const capped = truncatePlain(c.body.plainText, JIRA_MAX_COMMENT_CHARS);
    return {
      ...c,
      body: {
        plainText: capped.plainText,
        truncated: capped.truncated || c.body.truncated,
      },
    };
  });
  return {
    comments: slice,
    truncated: comments.length > JIRA_MAX_COMMENTS || slice.some((c) => c.body.truncated),
  };
}
