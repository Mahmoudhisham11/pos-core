import type { SqlDriver } from "../db/types";

/**
 * Seam for the cloud (Firestore) side. The legacy backend never talked to Firestore from the sync API itself
 * (the client owns the connection and drains `sync_queue`), so the default is a no-op; a host may inject a real
 * implementation that pushes/pulls through its own Firestore client.
 */
export interface CloudSync {
  /** Push the pending outbox rows; returns how many were delivered (and are safe to remove). */
  pushPending(db: SqlDriver): Promise<{ pushed: number }>;
  /** Pull remote documents of a collection as `{docId, data}` pairs (applied through /sync/apply-batch semantics). */
  pull(collectionName: string, since?: string | null): Promise<Array<{ docId: string; data: Record<string, unknown> }>>;
}

export const noopCloudSync: CloudSync = {
  async pushPending() { return { pushed: 0 }; },
  async pull() { return []; },
};
