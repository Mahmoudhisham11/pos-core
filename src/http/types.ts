import type { SqlDriver } from "../db/types";

export interface ApiRequest {
  method: string;
  /** Path below the API root, e.g. "/sales/abc" (no "/api" prefix, no query string). */
  path: string;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string>; // lower-case names
}
export interface ApiResponse { status: number; body: any }

export interface AuthUser { id: string; role: string; permissions: string[]; [k: string]: any }

export interface Ctx {
  db: SqlDriver;
  req: ApiRequest;
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  /** Set for authenticated routes. */
  user: AuthUser;
  /** Injectable clock (tests). */
  now: () => Date;
}

/** A handler returns the JSON body, or {__status, body} via `respond()` for non-200 codes. */
export type Handler = (ctx: Ctx) => any;
export interface RouteOpts { public?: boolean; write?: boolean }
