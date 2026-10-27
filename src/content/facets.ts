/**
 * Rich text on the way out: turning plain text into facets.
 *
 * Bluesky renders nothing on its own. A URL in a post is grey text unless a
 * facet marks its byte range; an @mention is grey text unless a facet carries
 * the mentioned account's **DID**, not its handle. Post the raw string without
 * facets and every link and mention you publish is dead text, with no error to
 * notice.
 *
 * The detection regexes are the ones from @atproto/api's `detectFacets`, kept
 * deliberately identical so a post written here segments the same way the
 * official client would segment it. What is *not* copied is the `tlds` package:
 * a mention is validated by resolving it, which is a check the TLD list only
 * approximates, and a bare domain is checked against a bundled common-TLD list
 * so "see example.com" links while "e.g. this" does not.
 *
 * Offsets are UTF-8 byte positions. An emoji before a link shifts every offset
 * after it, which is why nothing here indexes the JS string directly.
 */

import type { BlueskyClient } from "../api/client.js";
import { resolveDid } from "../api/identity.js";
import { utf16ToUtf8Index } from "./text.js";

export type Facet = {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, unknown>>;
};

// From @atproto/api packages/api/src/rich-text/util.ts, so detection here and in
// the official client cannot drift. The one edit: URL_REGEX's `(?<domain>…)`
// named group is unnamed here and read as group 5 instead, because a named
// capture group needs an ES2018 target and this file also compiles inside an
// app that targets ES2017. Same pattern, same groups, same matches.
const MENTION_REGEX = /(^|\s|\()(@)([a-zA-Z0-9.-]+)(\b)/g;
const URL_REGEX =
  /(^|\s|\()((https?:\/\/[\S]+)|(([a-z][a-z0-9]*(\.[a-z0-9]+)+)[\S]*))/gim;
/** Index of URL_REGEX's bare-domain group, the one that was `(?<domain>…)`. */
const URL_DOMAIN_GROUP = 5;
const TRAILING_PUNCTUATION_REGEX = /\p{P}+$/gu;
const TAG_REGEX =
  /(^|\s)[#＃]((?!️)[^\s­⁠ ​‌‍⃢]*[^\d\s\p{P}­⁠ ​‌‍⃢]+[^\s­⁠ ​‌‍⃢]*)?/gu;

/**
 * TLDs common enough that a bare domain in a post is a link and not a typo.
 *
 * The official client checks the full IANA list. Carrying 1,400 entries to
 * decide whether "foo.zuerich" is a link is not worth the maintenance, and the
 * failure mode of a miss is mild, the text stays plain, and an explicit
 * https:// prefix always works. The failure mode of a false positive is worse:
 * a post that links "e.g" to a domain someone else owns.
 */
const COMMON_TLDS = new Set(
  ("com net org io ai co dev app me gg xyz sh so to tv fm is us uk ca au nz de fr es it nl se no dk fi pl pt br mx ar cl " +
    "jp cn in ru ch at be cz gr hu ie il kr ro sg tr ua za edu gov mil int info biz name pro news blog site online store " +
    "tech space live life world today art design studio agency media cloud digital email link page pub social wiki work " +
    "one run bot cc ly gl im nu ms st sc td tk ws yt ee lt lv sk si hr bg rs by kz md am ge az uz mn tw hk my th vn id ph"
  ).split(/\s+/),
);

function hasCommonTld(domain: string): boolean {
  const tld = domain.split(".").pop();
  return Boolean(tld && COMMON_TLDS.has(tld.toLowerCase()));
}

/** A mention that still needs its handle turned into a DID. */
type PendingMention = { start: number; end: number; handle: string };

/**
 * Find every link, tag and mention in `text`.
 *
 * Returns the facets that need no lookup, plus the mentions that do. Kept
 * separate so a caller with no client (a dry run, a test) can still get links
 * and tags without pretending to resolve anything.
 */
export function detectFacets(
  text: string,
  options: { bareDomains?: boolean } = {},
): { facets: Facet[]; mentions: PendingMention[] } {
  const bareDomains = options.bareDomains !== false;
  const facets: Facet[] = [];
  const mentions: PendingMention[] = [];

  for (const match of text.matchAll(URL_REGEX)) {
    const raw = match[2];
    if (!raw) continue;
    let uri = raw;
    if (!uri.startsWith("http")) {
      const domain = match[URL_DOMAIN_GROUP];
      if (!domain) continue;
      if (!bareDomains || !hasCommonTld(domain)) continue;
      uri = `https://${uri}`;
    }
    const start = text.indexOf(raw, match.index ?? 0);
    let end = start + raw.length;
    // Sentence punctuation belongs to the sentence, not to the URL.
    if (/[.,;:!?]$/.test(uri)) {
      uri = uri.slice(0, -1);
      end--;
    }
    // A closing paren only ends the URL if the URL never opened one.
    if (/[)]$/.test(uri) && !uri.includes("(")) {
      uri = uri.slice(0, -1);
      end--;
    }
    if (end <= start) continue;
    facets.push({
      index: { byteStart: utf16ToUtf8Index(text, start), byteEnd: utf16ToUtf8Index(text, end) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }],
    });
  }

  for (const match of text.matchAll(TAG_REGEX)) {
    const leading = match[1] ?? "";
    const raw = match[2];
    if (!raw) continue;
    const tag = raw.trim().replace(TRAILING_PUNCTUATION_REGEX, "");
    // 64 graphemes is the lexicon cap; UTF-16 length is always >= that, so the
    // cheap check is enough to reject and only near-misses cost anything.
    if (!tag || tag.length > 640) continue;
    const start = (match.index ?? 0) + leading.length;
    facets.push({
      index: {
        byteStart: utf16ToUtf8Index(text, start),
        // +1 for the # itself, which is part of the facet range.
        byteEnd: utf16ToUtf8Index(text, start + 1 + tag.length),
      },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }

  for (const match of text.matchAll(MENTION_REGEX)) {
    const handle = match[3];
    if (!handle) continue;
    // A handle is a domain. "@everyone" is not a mention, it is a word.
    if (!handle.includes(".")) continue;
    const at = text.indexOf(handle, match.index ?? 0) - 1;
    if (at < 0) continue;
    mentions.push({ start: at, end: at + handle.length + 1, handle });
  }

  return { facets, mentions };
}

/**
 * Everything `detectFacets` finds, with mentions resolved to DIDs.
 *
 * A mention that does not resolve is dropped rather than failing the post: the
 * user wrote an email address, or a handle that has since changed, and refusing
 * to publish over it would be worse than publishing it as plain text.
 */
export async function buildFacets(
  client: BlueskyClient,
  text: string,
  options: { bareDomains?: boolean } = {},
): Promise<Facet[]> {
  const { facets, mentions } = detectFacets(text, options);

  const resolved = await Promise.all(
    mentions.map(async (m) => {
      try {
        return { ...m, did: await resolveDid(client, m.handle) };
      } catch {
        return null;
      }
    }),
  );

  for (const m of resolved) {
    if (!m) continue;
    facets.push({
      index: {
        byteStart: utf16ToUtf8Index(text, m.start),
        byteEnd: utf16ToUtf8Index(text, m.end),
      },
      features: [{ $type: "app.bsky.richtext.facet#mention", did: m.did }],
    });
  }

  // Overlapping facets are rejected by the appview, and a URL containing a #
  // can collide with a tag match. Sort, then keep the first of any overlap.
  facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
  const out: Facet[] = [];
  let lastEnd = -1;
  for (const facet of facets) {
    if (facet.index.byteStart < lastEnd) continue;
    out.push(facet);
    lastEnd = facet.index.byteEnd;
  }
  return out;
}

/**
 * Rich text on the way in: facets back to readable markdown.
 *
 * The wire format keeps text and facets apart, so a raw post reads as
 * "check this out" with the URL nowhere in the string. Anything that shows a
 * post to a model has to stitch them back together or the model sees a
 * reference to a link it cannot follow.
 *
 * This is `@atproto/api`'s `RichText.segments()` without the dependency: the
 * segmentation is a sort and a walk, and the package pulls in the whole
 * lexicon client for it.
 */
export function facetsToMarkdown(text: string, facets?: unknown): string {
  if (!text) return "";
  const list = Array.isArray(facets) ? (facets as Facet[]) : [];
  if (list.length === 0) return text;

  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  const slice = (start: number, end: number) => decoder.decode(bytes.slice(start, end));

  const sorted = [...list]
    .filter((f) => f?.index && Number.isFinite(f.index.byteStart) && Number.isFinite(f.index.byteEnd))
    .sort((a, b) => a.index.byteStart - b.index.byteStart);

  let cursor = 0;
  let out = "";
  for (const facet of sorted) {
    const { byteStart, byteEnd } = facet.index;
    if (byteStart < cursor || byteEnd > bytes.length || byteEnd <= byteStart) continue;
    out += slice(cursor, byteStart);
    const inner = slice(byteStart, byteEnd);
    const feature = facet.features?.[0] as Record<string, unknown> | undefined;
    const type = String(feature?.$type ?? "");

    if (type.endsWith("#link") && typeof feature?.uri === "string") {
      // Autolink syntax rather than [text](url): the visible text is often a
      // truncated version of the URL, and a model following a truncated link
      // gets a 404. Showing the real target is worth the lost prettiness.
      out += inner === feature.uri ? `<${feature.uri}>` : `[${inner}](${feature.uri})`;
    } else if (type.endsWith("#mention") && typeof feature?.did === "string") {
      out += `[${inner}](https://bsky.app/profile/${feature.did})`;
    } else {
      out += inner;
    }
    cursor = byteEnd;
  }
  out += slice(cursor, bytes.length);
  return out;
}
