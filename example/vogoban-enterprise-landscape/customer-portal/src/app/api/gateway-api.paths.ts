/**
 * Gateway paths generated from ../platform-gateway/openapi/platform-gateway.openapi.yaml
 * by scripts/generate-api-client.mjs (npm run generate:api). Do not edit by hand.
 *
 * Every gateway URL this portal calls is assembled from these constants, so the portal
 * cannot drift from the contract the gateway publishes.
 */

export const GATEWAY_PATHS = {
  apiCustomers: '/api/Customers', // GET
  apiCustomersById: '/api/Customers/{id}', // GET
  apiCustomersByIdOrders: '/api/Customers/{id}/orders', // GET
  apiOrders: '/api/Orders', // GET
  apiOrdersById: '/api/Orders/{id}', // GET
  apiOrdersByIdCancel: '/api/Orders/{id}/cancel', // POST
  apiOrdersPost: '/api/orders', // POST
  apiGatewayInfo: '/api/gateway/info', // GET
  apiReports: '/api/Reports', // GET
  apiReportsRequests: '/api/Reports/requests', // POST
} as const;

export type GatewayPath = (typeof GATEWAY_PATHS)[keyof typeof GATEWAY_PATHS];

const placeholder = /\{([^}]+)\}/g;

/**
 * Substitutes the `{name}` placeholders of a generated gateway path with the supplied
 * values, so no caller ever assembles a gateway URL from a string literal.
 */
export function buildPath(path: GatewayPath, values: Record<string, string> = {}): string {
  return path.replace(placeholder, (match: string, name: string) => {
    const value = values[name];

    if (value === undefined) {
      throw new Error(`No value supplied for ${match} in gateway path ${path}.`);
    }

    return encodeURIComponent(value);
  });
}
