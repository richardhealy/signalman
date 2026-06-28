import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ObservabilityInterceptor } from './observability.interceptor';
import { ObservabilityModule } from './observability.module';

/** A provider is a class-token factory/useExisting record carrying `provide`. */
function provideTokens(providers: unknown[]): unknown[] {
  return providers.map((p) => (p as { provide?: unknown }).provide);
}

describe('ObservabilityModule.forRoot', () => {
  it('registers the interceptor globally by default', () => {
    const dynamic = ObservabilityModule.forRoot({ scope: 'inventory' });

    expect(dynamic.module).toBe(ObservabilityModule);
    expect(provideTokens(dynamic.providers ?? [])).toEqual([
      ObservabilityInterceptor,
      APP_INTERCEPTOR,
    ]);
    expect(dynamic.exports).toContain(ObservabilityInterceptor);
  });

  it('omits the global binding when global is false', () => {
    const dynamic = ObservabilityModule.forRoot({ scope: 'inventory', global: false });

    expect(provideTokens(dynamic.providers ?? [])).toEqual([ObservabilityInterceptor]);
  });

  it('builds a resolvable ObservabilityInterceptor through DI', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule.forRoot({ scope: 'inventory', global: false })],
    }).compile();

    expect(moduleRef.get(ObservabilityInterceptor)).toBeInstanceOf(ObservabilityInterceptor);
  });
});
