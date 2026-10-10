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
export const unauthorized = (message = "Could not validate credentials") => app(401, message, "UNAUTHORIZED");
export const forbidden = (permission: string) =>
  app(403, `Permission denied: Requires permission '${permission}'`, "FORBIDDEN", { required_permission: permission });
/** Plain FastAPI `HTTPException(status, detail="text")` -> body `{detail:"text"}`. */
export const httpError = (status: number, detail: string) => new HttpError(status, detail);
