import { describe, expect, it } from 'vitest';

import { detectKafkaTopicUsages } from './kafka-detect';

describe('kafka-detect', () => {
  it('detects NestJS subscribe decorator consumers', () => {
    const content = `
@Subscribe('payment.retry.requested')
handle() {}
`;
    const found = detectKafkaTopicUsages(content, 'handler.ts');
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: 'payment.retry.requested',
          role: 'consumer',
          detector: 'subscribe-decorator',
          confidence: 'high',
        }),
      ]),
    );
  });

  it('detects KafkaJS producer send', () => {
    const content = `
await producer.send({
  topic: 'payment.retry.requested',
  messages: [{ value: 'x' }],
});
`;
    const found = detectKafkaTopicUsages(content, 'producer.ts');
    expect(found.some((e) => e.role === 'producer' && e.detector === 'kafkajs')).toBe(true);
  });

  it('detects ClientKafka emit patterns', () => {
    const content = `
this.client.emit('payment.retry.requested', payload);
`;
    const found = detectKafkaTopicUsages(content, 'payments.service.ts');
    expect(found.some((e) => e.topic === 'payment.retry.requested' && e.role === 'producer')).toBe(
      true,
    );
  });
});
