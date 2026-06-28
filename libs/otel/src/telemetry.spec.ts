import { NodeSDK } from '@opentelemetry/sdk-node';
import { createTelemetry } from './telemetry';

describe('createTelemetry', () => {
  it('builds a handle wrapping a Node SDK', () => {
    const telemetry = createTelemetry({ serviceName: 'coordinator' });

    expect(telemetry.sdk).toBeInstanceOf(NodeSDK);
    expect(typeof telemetry.start).toBe('function');
    expect(typeof telemetry.shutdown).toBe('function');
  });

  it('starts the underlying SDK only once', () => {
    const telemetry = createTelemetry({ serviceName: 'coordinator' });
    const startSpy = jest.spyOn(telemetry.sdk, 'start').mockImplementation(() => undefined);

    telemetry.start();
    telemetry.start();

    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('shuts the SDK down once it has started, and is idempotent', async () => {
    const telemetry = createTelemetry({ serviceName: 'coordinator' });
    jest.spyOn(telemetry.sdk, 'start').mockImplementation(() => undefined);
    const shutdownSpy = jest.spyOn(telemetry.sdk, 'shutdown').mockResolvedValue(undefined);

    telemetry.start();
    await telemetry.shutdown();
    await telemetry.shutdown();

    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('does not shut down an SDK that never started', async () => {
    const telemetry = createTelemetry({ serviceName: 'coordinator' });
    const shutdownSpy = jest.spyOn(telemetry.sdk, 'shutdown').mockResolvedValue(undefined);

    await telemetry.shutdown();

    expect(shutdownSpy).not.toHaveBeenCalled();
  });
});
