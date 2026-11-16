import { dashboardRequest } from "./data.js";

export function createProduct(token, input) {
  return dashboardRequest("/v1/creator/products", {
    method: "POST",
    token,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ name: input.name, promise: input.promise })
  });
}
