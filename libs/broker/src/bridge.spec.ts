import { toConsumedMessage } from './bridge';

describe('toConsumedMessage', () => {
  it('maps a broker message onto an inbox ConsumedMessage', () => {
    const headers = { traceparent: 'tp' };

    expect(
      toConsumedMessage({
        id: 'm1',
        subject: 'ledger.committed',
        payload: { amount: 42 },
        headers,
      }),
    ).toEqual({
      messageId: 'm1',
      eventType: 'ledger.committed',
      headers,
    });
  });
});
