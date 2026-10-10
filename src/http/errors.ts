/** Mirrors FastAPI's HTTPException / AppException so response bodies match the legacy backend exactly. */
export class HttpError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

const app = (status: number, message: string, error_code: string, details: Record<string, unknown> = {}) =>
  new HttpError(status, { error_code, message, details });

export const badRequest = (message: string, error_code = "BAD_REQUEST", details: Record<string, unknown> = {}) =>
  app(400, message, error_code, details);
export const businessRule = (message: string, error_code = "BUSINESS_RULE_VIOLATION", details: Record<string, unknown> = {}) =>
  app(400, message, error_code, details);
export const notFoundEntity = (entity: string, id: unknown) =>
  app(404, `${entity} with ID '${id}' not found.`, "ENTITY_NOT_FOUND", { entity, id: String(id) });
export const duplicateEntity = (entity: string, field: string, value: unknown) =>
  app(409, `${entity} with ${field} '${value}' already exists.`, "DUPLICATE_ENTITY", { entity, field, value: String(value) });
export const insufficientStock = (productId: string, locationId: string, available: number, requested: number) =>
  app(400, `Insufficient stock for product '${productId}' at location '${locationId}'. Available: ${available}, Requested: ${requested}`,
    "INSUFFICIENT_STOCK", { product_id: productId, location_id: locationId, available, requested });
export const unauthorized = (message = "Could not validate credentials") => app(401, message, "UNAUTHORIZED");
export const forbidden = (permission: string) =>
  app(403, `Permission denied: Requires permission '${permission}'`, "FORBIDDEN", { required_permission: permission });
/** Plain FastAPI `HTTPException(status, detail="text")` -> body `{detail:"text"}`. */
export const httpError = (status: number, detail: string) => new HttpError(status, detail);
