import { SERVICE_NAMESPACE, buildResource } from './resource';

const ATTR_SERVICE_NAME = 'service.name';
const ATTR_SERVICE_VERSION = 'service.version';
const ATTR_SERVICE_NAMESPACE = 'service.namespace';
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';

describe('buildResource', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sets the service name and the shared namespace', () => {
    const { attributes } = buildResource({ serviceName: 'inventory' });

    expect(attributes[ATTR_SERVICE_NAME]).toBe('inventory');
    expect(attributes[ATTR_SERVICE_NAMESPACE]).toBe(SERVICE_NAMESPACE);
  });

  it('includes the service version only when provided', () => {
    expect(buildResource({ serviceName: 'ledger' }).attributes[ATTR_SERVICE_VERSION]).toBeUndefined();
    expect(
      buildResource({ serviceName: 'ledger', serviceVersion: '1.2.3' }).attributes[
        ATTR_SERVICE_VERSION
      ],
    ).toBe('1.2.3');
  });

  it('lets the caller override the namespace', () => {
    const { attributes } = buildResource({
      serviceName: 'payments',
      serviceNamespace: 'other-system',
    });

    expect(attributes[ATTR_SERVICE_NAMESPACE]).toBe('other-system');
  });

  it('uses an explicit environment over the surrounding env vars', () => {
    process.env.NODE_ENV = 'production';

    const { attributes } = buildResource({ serviceName: 'supplier', environment: 'staging' });

    expect(attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe('staging');
  });

  it('falls back to DEPLOYMENT_ENVIRONMENT, then NODE_ENV', () => {
    process.env.DEPLOYMENT_ENVIRONMENT = 'qa';
    process.env.NODE_ENV = 'production';
    expect(buildResource({ serviceName: 's' }).attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe(
      'qa',
    );

    delete process.env.DEPLOYMENT_ENVIRONMENT;
    expect(buildResource({ serviceName: 's' }).attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe(
      'production',
    );
  });

  it('defaults the environment to development when nothing is set', () => {
    delete process.env.DEPLOYMENT_ENVIRONMENT;
    delete process.env.NODE_ENV;

    expect(buildResource({ serviceName: 's' }).attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe(
      'development',
    );
  });

  it('merges caller attributes, which win over the defaults', () => {
    const { attributes } = buildResource({
      serviceName: 'notifier',
      attributes: { 'service.name': 'overridden', region: 'eu-west-1' },
    });

    expect(attributes[ATTR_SERVICE_NAME]).toBe('overridden');
    expect(attributes.region).toBe('eu-west-1');
  });

  it('keeps the telemetry SDK attributes from the default resource', () => {
    const { attributes } = buildResource({ serviceName: 'gateway' });

    expect(attributes['telemetry.sdk.language']).toBe('nodejs');
  });
});
