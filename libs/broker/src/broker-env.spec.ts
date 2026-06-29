import { InMemoryBroker } from './memory-broker';
import {
  createBrokerFromEnv,
  resolveBrokerKind,
  type BrokerKind,
} from './broker-env';

describe('resolveBrokerKind', () => {
  it('defaults to the in-memory broker when nothing is configured', () => {
    expect(resolveBrokerKind({})).toBe<BrokerKind>('memory');
  });

  it('reads the explicit memory and nats values', () => {
    expect(resolveBrokerKind({ BROKER: 'memory' })).toBe('memory');
    expect(resolveBrokerKind({ BROKER: 'nats' })).toBe('nats');
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(resolveBrokerKind({ BROKER: '  NATS  ' })).toBe('nats');
    expect(resolveBrokerKind({ BROKER: 'Memory' })).toBe('memory');
  });

  it('accepts friendly aliases', () => {
    expect(resolveBrokerKind({ BROKER: 'in-memory' })).toBe('memory');
    expect(resolveBrokerKind({ BROKER: 'jetstream' })).toBe('nats');
  });

  it('prefers SIGNALMAN_BROKER over the generic BROKER', () => {
    expect(resolveBrokerKind({ SIGNALMAN_BROKER: 'nats', BROKER: 'memory' })).toBe('nats');
  });

  it('falls through a blank value to the next key, then the default', () => {
    expect(resolveBrokerKind({ SIGNALMAN_BROKER: '   ', BROKER: 'nats' })).toBe('nats');
    expect(resolveBrokerKind({ SIGNALMAN_BROKER: '', BROKER: '' })).toBe('memory');
  });

  it('throws on an explicitly set but unrecognised value (fail fast on a typo)', () => {
    expect(() => resolveBrokerKind({ BROKER: 'rabbitmq' })).toThrow(/Unknown broker kind/);
    expect(() => resolveBrokerKind({ BROKER: 'rabbitmq' })).toThrow(/BROKER/);
  });
});

describe('createBrokerFromEnv', () => {
  it('builds an in-memory broker by default, with a callable close', async () => {
    const result = await createBrokerFromEnv({});

    expect(result.kind).toBe('memory');
    expect(result.broker).toBeInstanceOf(InMemoryBroker);
    await expect(result.close()).resolves.toBeUndefined();
  });

  it('the in-memory broker it builds actually delivers a published message', async () => {
    const { broker, close } = await createBrokerFromEnv({ BROKER: 'memory' });

    const received: string[] = [];
    broker.subscribe('demo.event', (message) => {
      received.push(String((message.payload as { hello: string }).hello));
      return Promise.resolve();
    });

    await broker.publish({
      id: 'm1',
      subject: 'demo.event',
      payload: { hello: 'world' },
      headers: {},
    });
    await (broker as InMemoryBroker).drain();

    expect(received).toEqual(['world']);
    await close();
  });
});
