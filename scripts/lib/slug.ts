// URL slugs for the prerendered pages. Shared by the generators and the
// sitemap writer so a page and its <loc> can never disagree.
//
// The dotted/dotless i is the trap. JS `toLowerCase()` maps "İ" to "i" plus a
// combining dot above (U+0307) and leaves "I" as "i", so lowercase-then-strip
// sends "İSTİKLAL" and "ISTIKLAL" to different slugs. Folding the Turkish
// letters to ASCII *before* lowercasing lands both on "istiklal". NFD handles
// the rest (â in "Kâğıthane", î, û) since those decompose; ı and İ do not.

const TR_FOLD: Record<string, string> = {
  ç: "c", Ç: "c",
  ğ: "g", Ğ: "g",
  ı: "i", İ: "i", I: "i",
  ö: "o", Ö: "o",
  ş: "s", Ş: "s",
  ü: "u", Ü: "u",
};

export function slugify(input: string): string {
  const folded = Array.from(input, (ch) => TR_FOLD[ch] ?? ch).join("");
  return folded
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class SlugCollisionError extends Error {
  readonly collisions: Map<string, string[]>;

  constructor(collisions: Map<string, string[]>) {
    const detail = [...collisions]
      .map(([slug, names]) => `  ${slug} ← ${names.join(" | ")}`)
      .join("\n");
    super(`slug collisions (distinct names sharing one URL):\n${detail}`);
    this.name = "SlugCollisionError";
    this.collisions = collisions;
  }
}

/**
 * Map every distinct name onto its slug, failing loudly when two *different* names
 * collapse onto the same URL — a silent collision overwrites one page with the
 * other and stays invisible for months. Repeats of the same name are fine:
 * "Yenikapı" appears once per line it serves and gets one shared page.
 */
export function slugIndex(names: Iterable<string>): Map<string, string> {
  const bySlug = new Map<string, Set<string>>();
  for (const name of names) {
    const slug = slugify(name);
    if (!slug) continue;
    let set = bySlug.get(slug);
    if (!set) bySlug.set(slug, (set = new Set()));
    set.add(name);
  }

  const collisions = new Map<string, string[]>();
  const out = new Map<string, string>();
  for (const [slug, set] of bySlug) {
    if (set.size > 1) collisions.set(slug, [...set].sort());
    else out.set(slug, [...set][0]);
  }
  if (collisions.size) throw new SlugCollisionError(collisions);
  return out;
}
