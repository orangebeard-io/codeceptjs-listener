import type { Attribute } from '@orangebeard-io/javascript-client/dist/client/models/Attribute';

/**
 * Extract tags from a CodeceptJS test or suite object.
 *
 * CodeceptJS stores tags in several locations depending on how they are defined:
 * - `test.tags` (array of strings like `['@slow', '@important']`)
 * - `test.opts.tags`
 * - Inline in the title (e.g. `Scenario('my test @smoke @regression', ...)`)
 */
export function extractTags(entity: any): string[] {
  const seen = new Set<string>();

  const add = (value: string) => {
    const t = value.trim();
    if (t) seen.add(t);
  };

  // Explicit tags arrays
  const candidates: unknown[] = [
    entity?.tags,
    entity?.opts?.tags,
    entity?.tag,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) {
      for (const item of c) {
        if (typeof item === 'string') add(item);
      }
    } else if (typeof c === 'string' && c.trim()) {
      for (const part of c.split(',')) {
        add(part);
      }
    }
  }

  return Array.from(seen);
}
export function extractTagsFromTitle(title: string | undefined): { cleanTitle: string; tags: string[] } {
  if (!title) return { cleanTitle: '', tags: [] };

  const parts = title.split(/\s+/);
  const tags: string[] = [];
  const kept: string[] = [];

  for (const p of parts) {
    if (p.startsWith('@') && p.length > 1) {
      tags.push(p);
    } else {
      kept.push(p);
    }
  }

  return {
    cleanTitle: kept.join(' ').trim(),
    tags,
  };
}

export function mergeAttributesFromEntityAndTitle(entity: any): { cleanTitle: string; attributes: Attribute[] } {
  const { cleanTitle, tags } = extractTagsFromTitle(entity?.title);
  const attrs = tagsToAttributes(tags);
  const entityAttrs = getTestAttributes(entity);
  return {
    cleanTitle: cleanTitle || entity?.title || '',
    attributes: [...attrs, ...entityAttrs],
  };
}

export function mergeSuiteAttributesFromTitle(title: string | undefined): { cleanTitle: string; attributes: Attribute[] } {
  const { cleanTitle, tags } = extractTagsFromTitle(title);
  return {
    cleanTitle: cleanTitle || title || '',
    attributes: tagsToAttributes(tags),
  };
}

export function tagsToAttributes(tags: string[]): Attribute[] {
  const attrs: Attribute[] = [];

  for (const raw of tags) {
    let t = raw.trim();
    if (!t) continue;
    if (t.startsWith('@')) t = t.slice(1);
    t = t.trim();
    if (!t) continue;

    const idx = t.indexOf(':');
    if (idx > 0) {
      const key = t.slice(0, idx).trim();
      const value = t.slice(idx + 1).trim();
      if (key && value) attrs.push({ key, value });
      continue;
    }

    attrs.push({ value: t });
  }

  // de-dupe
  const seen = new Set<string>();
  const unique: Attribute[] = [];
  for (const a of attrs) {
    const k = `${a.key ?? ''}:${a.value ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(a);
  }

  return unique;
}

export function getTestAttributes(test: any): Attribute[] {
  return tagsToAttributes(extractTags(test));
}
