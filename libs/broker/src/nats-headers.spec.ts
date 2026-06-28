import { headers as createNatsHeaders } from 'nats';
import { decodeNatsHeaders, encodeNatsHeaders, MESSAGE_ID_HEADER } from './nats-headers';

describe('encodeNatsHeaders', () => {
  it('writes a string header through unchanged', () => {
    const encoded = encodeNatsHeaders({ traceparent: '00-abc-def-01' });
    expect(encoded.get('traceparent')).toBe('00-abc-def-01');
  });

  it('drops undefined values', () => {
    const encoded = encodeNatsHeaders({ traceparent: undefined, tracestate: 'a=b' });
    expect(encoded.has('traceparent')).toBe(false);
    expect(encoded.get('tracestate')).toBe('a=b');
  });

  it('expands a string array into a multi-valued header', () => {
    const encoded = encodeNatsHeaders({ tags: ['a', 'b'] });
    expect(encoded.values('tags')).toEqual(['a', 'b']);
  });

  it('writes a Buffer as its UTF-8 text', () => {
    const encoded = encodeNatsHeaders({ traceparent: Buffer.from('00-abc-def-01', 'utf8') });
    expect(encoded.get('traceparent')).toBe('00-abc-def-01');
  });

  it('adds to an existing MsgHdrs when one is passed', () => {
    const existing = createNatsHeaders();
    existing.set('keep', 'me');
    const encoded = encodeNatsHeaders({ traceparent: '00-abc-def-01' }, existing);
    expect(encoded.get('keep')).toBe('me');
    expect(encoded.get('traceparent')).toBe('00-abc-def-01');
  });
});

describe('decodeNatsHeaders', () => {
  it('returns an empty object for absent headers', () => {
    expect(decodeNatsHeaders(undefined)).toEqual({});
  });

  it('decodes a single-valued header to a string', () => {
    const hdrs = createNatsHeaders();
    hdrs.set('traceparent', '00-abc-def-01');
    expect(decodeNatsHeaders(hdrs)).toEqual({ traceparent: '00-abc-def-01' });
  });

  it('decodes a multi-valued header to a string array', () => {
    const hdrs = createNatsHeaders();
    hdrs.append('tags', 'a');
    hdrs.append('tags', 'b');
    expect(decodeNatsHeaders(hdrs).tags).toEqual(['a', 'b']);
  });

  it('strips the adapter message-id header from the application view', () => {
    const hdrs = createNatsHeaders();
    hdrs.set(MESSAGE_ID_HEADER, 'evt_1');
    hdrs.set('traceparent', '00-abc-def-01');
    const decoded = decodeNatsHeaders(hdrs);
    expect(decoded[MESSAGE_ID_HEADER]).toBeUndefined();
    expect(decoded.traceparent).toBe('00-abc-def-01');
  });

  it('round-trips application headers through encode then decode', () => {
    const original = { traceparent: '00-abc-def-01', tracestate: 'vendor=value' };
    expect(decodeNatsHeaders(encodeNatsHeaders(original))).toEqual(original);
  });
});
