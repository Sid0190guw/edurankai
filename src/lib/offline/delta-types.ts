// src/lib/offline/delta-types.ts — Block 06: wire types for the version-cursor delta protocol.
// The client stores a SyncCursor per package; on reconnect it POSTs the cursor to
// /api/aquintutor/offline/delta and applies the DeltaResponse.
export interface SyncCursor {
  packageId: string;
  highWatermark: number;   // max kernel_objects.version the client has applied
  lastSyncedAt: string;    // ISO
}

export interface DeltaObject {
  id: string;
  type: string;
  version: number;
  syncState: 'synced' | 'dirty' | 'pending' | 'conflict';
  updatedAt: string;
  payload?: unknown;       // re-rendered inline payload OR { blobUrl } for heavy media
}

export interface DeltaResponse {
  changed: DeltaObject[];  // objects with version > cursor.highWatermark OR state <> 'synced'
  affected: string[];      // ids pulled in by dependency propagation
  removed: string[];       // objects archived/deleted since the cursor
  newWatermark: number;    // the client stores this as the next cursor.highWatermark
  conflicts: string[];     // ids where both sides changed -> student must reconcile
}
