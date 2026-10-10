const env = (k: string): string | undefined => (typeof process !== "undefined" ? process.env?.[k] : undefined);

/**
 * Port of core/config.py. The per-install secret is persisted by the host (desktop shell) and passed in through
 * `configure({ SECRET_KEY })`; without it a process-lifetime random secret is used (tokens die on restart).
 */
export const settings = {
  APP_NAME: "Nelly ERP Desktop API",
  APP_ENV: "development",
  DEBUG: false,
  API_V1_STR: "/api",
  SECRET_KEY: env("SECRET_KEY") ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""),
  ALGORITHM: "HS256",
  ACCESS_TOKEN_EXPIRE_MINUTES: 60 * 24 * 30, // 30 days
  LOGIN_MAX_FAILURES: 5,
  LOGIN_LOCK_SECONDS: 60,
  PASSWORD_MIN_LENGTH: 4,
  DEVICE_ID: "desktop-local-01",
  /** Firebase project whose accounts may log in on this device (set by the host). Empty = cloud login disabled. */
  FIREBASE_PROJECT_ID: env("NEXT_PUBLIC_FIREBASE_PROJECT_ID") ?? "",
};

export function configure(patch: Partial<typeof settings>): void {
  Object.assign(settings, patch);
}
