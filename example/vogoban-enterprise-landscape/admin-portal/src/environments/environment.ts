/** Configuration for the admin portal. The gateway base URL is the only runtime endpoint it needs. */
export const environment = {
  production: false,
  gatewayBaseUrl: 'http://localhost:5180',
  gatewayOpenApi: '../platform-gateway/openapi/platform-gateway.openapi.yaml',
};
