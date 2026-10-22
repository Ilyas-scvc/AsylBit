/** Musical event types produced by the heuristic detectors. */
export const EventType = {
  /** probable kick drum: low-band transient with a real energy rise */
  KICK: 0,
  /** probable snare / clap: broadband mid + high transient */
  SNARE: 1,
  /** probable hi-hat / cymbal tick: isolated high-band transient */
  HAT: 2,
  /** other tonal attack in the mids (chord stab, pluck, vocal onset) */
  TONE: 3,
} as const;

export type EventTypeId = (typeof EventType)[keyof typeof EventType];

export const EVENT_LABELS = ['KICK', 'SNARE', 'HAT', 'TONE'] as const;

/** Time-sorted event map, stored as parallel typed arrays to stay compact and transferable. */
export interface EventMap {
  times: Float32Array;
  strengths: Float32Array;
  types: Uint8Array;
}

export function emptyEventMap(): EventMap {
  return { times: new Float32Array(0), strengths: new Float32Array(0), types: new Uint8Array(0) };
}
