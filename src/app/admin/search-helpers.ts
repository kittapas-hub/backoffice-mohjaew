/**
 * Sanitise a user-supplied admin search term before embedding it in a
 * PostgREST `.or()` filter string.
 *
 * Stripped characters and why:
 *   %  _   — PostgreSQL ILIKE wildcards; we add our own, user input must not
 *             inject extras (e.g. bare "%" would match every row)
 *   '  "   — PostgREST uses double-quotes to quote filter values and SQL uses
 *             single-quotes for strings; strip both to avoid parser confusion
 *   (  )   — PostgREST filter grouping syntax
 *   ,      — PostgREST filter separator inside .or()
 */
export function sanitizeSearch(raw: string): string {
  return raw.trim().slice(0, 100).replace(/[%_'"(),]/g, "");
}
