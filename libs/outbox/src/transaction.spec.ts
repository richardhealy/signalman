import { runInTransaction, type UnitOfWork } from './transaction';

describe('runInTransaction', () => {
  it('applies every enlisted write when the body resolves', async () => {
    const applied: string[] = [];

    await runInTransaction(async (tx) => {
      tx.defer(() => applied.push('a'));
      tx.defer(() => applied.push('b'));
    });

    expect(applied).toEqual(['a', 'b']);
  });

  it('returns the body’s value, after the writes have committed', async () => {
    const applied: string[] = [];

    const result = await runInTransaction(async (tx) => {
      tx.defer(() => applied.push('write'));
      return 'outcome';
    });

    expect(result).toBe('outcome');
    expect(applied).toEqual(['write']);
  });

  it('applies no enlisted write when the body throws — the rollback', async () => {
    const applied: string[] = [];

    await expect(
      runInTransaction(async (tx) => {
        tx.defer(() => applied.push('a'));
        tx.defer(() => applied.push('b'));
        throw new Error('aborted after enlisting');
      }),
    ).rejects.toThrow('aborted after enlisting');

    expect(applied).toEqual([]);
  });

  it('defers writes — nothing is applied until the body resolves', async () => {
    const applied: string[] = [];
    let appliedDuringBody = -1;

    await runInTransaction(async (tx: UnitOfWork) => {
      tx.defer(() => applied.push('a'));
      // The enlisted write has not run yet: commit happens after the body.
      appliedDuringBody = applied.length;
    });

    expect(appliedDuringBody).toBe(0);
    expect(applied).toEqual(['a']);
  });

  it('commits cleanly with nothing enlisted', async () => {
    await expect(runInTransaction(async () => 7)).resolves.toBe(7);
  });
});
