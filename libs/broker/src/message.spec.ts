import { subjectMatches } from './message';

describe('subjectMatches', () => {
  it('matches an exact subject', () => {
    expect(subjectMatches('ledger.committed', 'ledger.committed')).toBe(true);
  });

  it('rejects a different subject of the same length', () => {
    expect(subjectMatches('ledger.committed', 'ledger.reversed')).toBe(false);
  });

  it('rejects a subject with a different token count', () => {
    expect(subjectMatches('ledger.committed', 'ledger')).toBe(false);
    expect(subjectMatches('ledger', 'ledger.committed')).toBe(false);
  });

  it('matches a single token with *', () => {
    expect(subjectMatches('inventory.*', 'inventory.held')).toBe(true);
    expect(subjectMatches('*.committed', 'ledger.committed')).toBe(true);
  });

  it('* matches exactly one token, not several', () => {
    expect(subjectMatches('inventory.*', 'inventory.held.eu')).toBe(false);
    expect(subjectMatches('inventory.*', 'inventory')).toBe(false);
  });

  it('matches one or more trailing tokens with >', () => {
    expect(subjectMatches('inventory.>', 'inventory.held')).toBe(true);
    expect(subjectMatches('inventory.>', 'inventory.held.eu')).toBe(true);
  });

  it('> requires at least one trailing token', () => {
    expect(subjectMatches('inventory.>', 'inventory')).toBe(false);
  });

  it('> at the root matches any non-empty subject', () => {
    expect(subjectMatches('>', 'ledger.committed')).toBe(true);
    expect(subjectMatches('>', 'inventory')).toBe(true);
  });
});
