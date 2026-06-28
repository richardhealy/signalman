import { deliverSubject, durableName } from './nats-broker';

describe('durableName', () => {
  it('is a pure function of stream, queue, and pattern', () => {
    expect(durableName('SIGNALMAN', 'workers', 'ledger.committed')).toBe(
      durableName('SIGNALMAN', 'workers', 'ledger.committed'),
    );
  });

  it('sanitises subject wildcards and dots into legal durable characters', () => {
    const name = durableName('SIGNALMAN', 'workers', 'inventory.*');
    expect(name).not.toMatch(/[.*>\s/\\]/);
    expect(name).toBe('SIGNALMAN-workers-inventory__');
  });

  it('distinguishes different queue groups and patterns', () => {
    expect(durableName('S', 'a', 'ledger.committed')).not.toBe(
      durableName('S', 'b', 'ledger.committed'),
    );
    expect(durableName('S', 'a', 'ledger.committed')).not.toBe(
      durableName('S', 'a', 'ledger.reversed'),
    );
  });
});

describe('deliverSubject', () => {
  it('is deterministic, so queue-group members share one deliver subject', () => {
    expect(deliverSubject('SIGNALMAN', 'workers', 'ledger.committed')).toBe(
      deliverSubject('SIGNALMAN', 'workers', 'ledger.committed'),
    );
  });

  it('lives outside the captured subject space so deliveries do not loop', () => {
    expect(deliverSubject('SIGNALMAN', 'workers', 'ledger.committed')).toMatch(
      /^_signalman\.deliver\./,
    );
  });

  it('carries no wildcard tokens', () => {
    const subject = deliverSubject('SIGNALMAN', 'workers', 'inventory.>');
    expect(subject).not.toMatch(/[*>]/);
  });
});
