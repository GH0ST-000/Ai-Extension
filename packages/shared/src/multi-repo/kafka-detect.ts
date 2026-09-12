import type { RelationshipConfidence } from '@project-x/types';

export type KafkaUsageRole = 'producer' | 'consumer';

export interface KafkaTopicEvidence {
  topic: string;
  role: KafkaUsageRole;
  confidence: RelationshipConfidence;
  summary: string;
  detector: 'nestjs-client-kafka' | 'kafkajs' | 'subscribe-decorator' | 'topic-literal';
  line?: number;
  excerpt?: string;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function excerptAround(content: string, index: number, length = 120): string {
  const start = Math.max(0, index - 20);
  return content
    .slice(start, start + length)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTopic(raw: string): string {
  return raw.trim().replace(/^['"`]|['"`]$/g, '');
}

function isPlausibleTopic(topic: string): boolean {
  if (!topic || topic.length < 2 || topic.length > 200) return false;
  if (/\s/.test(topic)) return false;
  // Prefer dotted / kebab / snake topic names; reject path-like and URL-like
  if (topic.startsWith('/') || topic.includes('://')) return false;
  return /^[A-Za-z0-9._-]+$/.test(topic);
}

function pushUnique(out: KafkaTopicEvidence[], item: KafkaTopicEvidence): void {
  const key = `${item.role}|${item.topic}|${item.detector}|${item.line ?? ''}`;
  if (out.some((e) => `${e.role}|${e.topic}|${e.detector}|${e.line ?? ''}` === key)) {
    return;
  }
  out.push(item);
}

/** Deterministic Kafka topic producer/consumer heuristics (no live broker). */
export function detectKafkaTopicUsages(content: string, _path: string): KafkaTopicEvidence[] {
  const out: KafkaTopicEvidence[] = [];
  let match: RegExpExecArray | null;

  // NestJS @MessagePattern / @EventPattern / custom @Subscribe("topic")
  const subscribeRe = /@(?:Subscribe|EventPattern|MessagePattern)\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  while ((match = subscribeRe.exec(content)) !== null) {
    const topic = normalizeTopic(match[2] ?? '');
    if (!isPlausibleTopic(topic)) continue;
    pushUnique(out, {
      topic,
      role: 'consumer',
      confidence: 'high',
      summary: `Subscribe decorator for topic ${topic}`,
      detector: 'subscribe-decorator',
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  // NestJS ClientKafka emit/send
  const nestEmitRe = /\.(?:emit|send)\(\s*(['"`])([^'"`]+)\1/g;
  while ((match = nestEmitRe.exec(content)) !== null) {
    const topic = normalizeTopic(match[2] ?? '');
    if (!isPlausibleTopic(topic)) continue;
    const window = content.slice(Math.max(0, match.index - 80), match.index + 40);
    if (!/ClientKafka|kafka|producer|emit|send/i.test(window) && !/kafka/i.test(content)) {
      continue;
    }
    pushUnique(out, {
      topic,
      role: 'producer',
      confidence: /ClientKafka/i.test(content) ? 'high' : 'medium',
      summary: `ClientKafka-style emit/send to ${topic}`,
      detector: 'nestjs-client-kafka',
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  // KafkaJS producer.send({ topic: "..." })
  const kafkaJsSendRe = /\.send\(\s*\{[\s\S]{0,200}?topic\s*:\s*(['"`])([^'"`]+)\1/g;
  while ((match = kafkaJsSendRe.exec(content)) !== null) {
    const topic = normalizeTopic(match[2] ?? '');
    if (!isPlausibleTopic(topic)) continue;
    pushUnique(out, {
      topic,
      role: 'producer',
      confidence: 'high',
      summary: `KafkaJS producer send to ${topic}`,
      detector: 'kafkajs',
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  // KafkaJS consumer.subscribe({ topic: "..." })
  const kafkaJsSubRe = /\.subscribe\(\s*\{[\s\S]{0,200}?topic\s*:\s*(['"`])([^'"`]+)\1/g;
  while ((match = kafkaJsSubRe.exec(content)) !== null) {
    const topic = normalizeTopic(match[2] ?? '');
    if (!isPlausibleTopic(topic)) continue;
    pushUnique(out, {
      topic,
      role: 'consumer',
      confidence: 'high',
      summary: `KafkaJS consumer subscribe to ${topic}`,
      detector: 'kafkajs',
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  // Generic topic: "..." near kafka/producer/consumer keywords
  const topicLiteralRe = /\btopic\s*:\s*(['"`])([^'"`]+)\1/g;
  while ((match = topicLiteralRe.exec(content)) !== null) {
    const topic = normalizeTopic(match[2] ?? '');
    if (!isPlausibleTopic(topic)) continue;
    const window = content.slice(Math.max(0, match.index - 100), match.index + 100);
    if (!/kafka|producer|consumer|subscribe|ClientKafka/i.test(window)) continue;

    const role: KafkaUsageRole = /subscribe|consumer|eachMessage|@Subscribe/i.test(window)
      ? 'consumer'
      : /send|emit|produce|producer/i.test(window)
        ? 'producer'
        : 'producer';

    pushUnique(out, {
      topic,
      role,
      confidence: 'low',
      summary: `Topic literal ${topic}`,
      detector: 'topic-literal',
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  return out;
}
