import type { StackFrame } from '@project-x/types';

import { MAX_STACK_FRAMES } from './error-intelligence.constants';

/**
 * Lightweight JS/Node-style stack frame parser.
 * Never throws on malformed input.
 */
export function parseStackTrace(text: string, maxFrames = MAX_STACK_FRAMES): StackFrame[] {
  try {
    const frames: StackFrame[] = [];
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      if (frames.length >= maxFrames) {
        break;
      }
      const frame = parseStackFrameLine(line);
      if (frame) {
        frames.push(frame);
      }
    }

    return frames;
  } catch {
    return [];
  }
}

function parseStackFrameLine(line: string): StackFrame | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  // at FunctionName (file:line:col)
  let match = trimmed.match(/^at\s+(?:async\s+)?([^\s(]+)\s+\((.+):(\d+):(\d+)\)$/);
  if (match) {
    return {
      functionName: match[1],
      file: match[2],
      line: Number(match[3]),
      column: Number(match[4]),
    };
  }

  // at file:line:col
  match = trimmed.match(/^at\s+(?:async\s+)?(.+):(\d+):(\d+)$/);
  if (match) {
    return {
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
    };
  }

  // at Object.fn [as name] (file:line:col)
  match = trimmed.match(/^at\s+(?:async\s+)?(.+?)\s+\[as\s+[^\]]+\]\s+\((.+):(\d+):(\d+)\)$/);
  if (match) {
    return {
      functionName: match[1],
      file: match[2],
      line: Number(match[3]),
      column: Number(match[4]),
    };
  }

  // V8: FunctionName@file:line:col (Firefox-ish)
  match = trimmed.match(/^([^@\s]+)@(.+):(\d+):(\d+)$/);
  if (match) {
    return {
      functionName: match[1],
      file: match[2],
      line: Number(match[3]),
      column: Number(match[4]),
    };
  }

  return null;
}

/** Extract a contiguous stack-ish region for raw preservation. */
export function extractStackTraceRaw(text: string, maxChars: number): string | undefined {
  const lines = text.split(/\r?\n/);
  const stackLines = lines.filter(
    (line) => /^\s*at\s+/.test(line) || /@[^:]+:\d+:\d+/.test(line.trim()),
  );
  if (stackLines.length === 0) {
    return undefined;
  }
  const raw = stackLines.join('\n');
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
}
