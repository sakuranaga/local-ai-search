// Bulk permissions dialog: start from the files' own permissions, send only what was changed
export const MIXED = "mixed" as const;
export type Mixed = typeof MIXED;

export interface PermissionSource {
  group_id: string | null;
  group_read: boolean;
  group_write: boolean;
  others_read: boolean;
  others_write: boolean;
}

export interface PermissionChoice {
  group_id: string | Mixed; // "" = no group
  group_read: boolean | Mixed;
  group_write: boolean | Mixed;
  others_read: boolean | Mixed;
  others_write: boolean | Mixed;
}

const FIELDS = ["group_id", "group_read", "group_write", "others_read", "others_write"] as const;

/** Each field's common value over the files, or MIXED where they differ. */
export function currentPermissions(items: PermissionSource[]): PermissionChoice {
  const value = (d: PermissionSource, f: (typeof FIELDS)[number]) => (f === "group_id" ? d.group_id ?? "" : d[f]);
  const out = {} as Record<string, unknown>;
  for (const f of FIELDS) {
    const first = items.length ? value(items[0], f) : MIXED;
    out[f] = items.every((d) => value(d, f) === first) ? first : MIXED;
  }
  return out as unknown as PermissionChoice;
}

/** The fields to send: changed from the start and not left mixed. */
export function permissionChanges(start: PermissionChoice, now: PermissionChoice): Partial<PermissionSource> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (now[f] !== MIXED && now[f] !== start[f]) out[f] = now[f];
  }
  return out as Partial<PermissionSource>;
}

/** A click on a box: one that started mixed goes on, off, then back to unchanged. */
export function nextBit(start: boolean | Mixed, now: boolean | Mixed): boolean | Mixed {
  if (now === MIXED) return true;
  if (start === MIXED && now === false) return MIXED;
  return !now;
}
