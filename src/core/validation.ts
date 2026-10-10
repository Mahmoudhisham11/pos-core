import { HttpError } from "../http/errors";

/** FastAPI's RequestValidationError rendered by the legacy handler (main.py). */
export const validationFailed = (errors: Array<{ field: string; message: string }>) =>
  new HttpError(422, { error_code: "VALIDATION_ERROR", message: "Request validation failed", errors });

/** Collects pydantic-style field errors; `done()` throws one 422 with all of them. */
export class Validator {
  errors: Array<{ field: string; message: string }> = [];
  constructor(private loc: "body" | "query" = "body") {}
  private err(key: string, message: string) { this.errors.push({ field: `${this.loc} -> ${key}`, message }); }

  /** Optional/required string (pydantic v2 strict about types: numbers are not coerced to str). */
  str(src: any, key: string, o: { required?: boolean; min?: number; max?: number } = {}): string | null | undefined {
    const v = src?.[key];
    if (v === undefined || v === null) {
      if (o.required) this.err(key, "Field required");
      return v === null ? null : undefined;
    }
    if (typeof v !== "string") { this.err(key, "Input should be a valid string"); return undefined; }
    if (o.min !== undefined && v.length < o.min) { this.err(key, `String should have at least ${o.min} character${o.min === 1 ? "" : "s"}`); return undefined; }
    if (o.max !== undefined && v.length > o.max) { this.err(key, `String should have at most ${o.max} characters`); return undefined; }
    return v;
  }

  bool(src: any, key: string): boolean | null | undefined {
    const v = src?.[key];
    if (v === undefined || v === null) return v === null ? null : undefined;
    if (typeof v === "boolean") return v;
    if (v === 0 || v === 1) return v === 1;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["true", "1", "yes", "on", "t", "y"].includes(s)) return true;
      if (["false", "0", "no", "off", "f", "n"].includes(s)) return false;
    }
    this.err(key, "Input should be a valid boolean");
    return undefined;
  }

  int(src: any, key: string, o: { ge?: number; le?: number; required?: boolean } = {}): number | null | undefined {
    const v = src?.[key];
    if (v === undefined || v === null) {
      if (o.required) this.err(key, "Field required");
      return v === null ? null : undefined;
    }
    let n: number | null = null;
    if (typeof v === "number" && Number.isInteger(v)) n = v;
    else if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) n = parseInt(v, 10);
    if (n === null) { this.err(key, "Input should be a valid integer, unable to parse string as an integer"); return undefined; }
    if (o.ge !== undefined && n < o.ge) { this.err(key, `Input should be greater than or equal to ${o.ge}`); return undefined; }
    if (o.le !== undefined && n > o.le) { this.err(key, `Input should be less than or equal to ${o.le}`); return undefined; }
    return n;
  }

  push(key: string, message: string) { this.err(key, message); }
  done(): void { if (this.errors.length) throw validationFailed(this.errors); }
}
