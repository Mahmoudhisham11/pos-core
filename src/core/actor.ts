/**
 * Who is performing the current request. Handlers run synchronously (one at a time, see http/router), so the router
 * sets this for the duration of a handler and domain code can stamp records (e.g. stock movements) without threading
 * the user through every call.
 */
export interface Actor { id: string | null; name: string | null }

let current: Actor = { id: null, name: null };

export const currentActor = (): Actor => current;

export function withActor<T>(user: Record<string, any> | null | undefined, fn: () => T): T {
  const prev = current;
  current = user && user.id
    ? { id: String(user.id), name: String(user.displayName || user.name || user.email || "") || null }
    : { id: null, name: null };
  try {
    return fn();
  } finally {
    current = prev;
  }
}
