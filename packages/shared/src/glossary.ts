import {
  AMBIGUOUS_ALIAS_DENYLIST,
  MIN_DETERMINISTIC_ALIAS_LENGTH,
  type DictionaryTerm,
} from "./dictionary.js";
import type { GlossaryEntry } from "./providers.js";

/** Letters that may be part of a "word" for boundary purposes, incl. Cyrillic. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

function normalizeForMatch(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

/**
 * Escapes a string for literal use inside a RegExp.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface GlossarySelection {
  entries: GlossaryEntry[];
  /** Terms omitted because the budget was reached. */
  omitted: number;
}

/**
 * Picks the glossary subset worth sending with one correction request.
 *
 * Sending the whole dictionary on every phrase wastes tokens and latency, so terms
 * are scored: an alias or canonical form actually present in the transcript wins,
 * everything else is ranked by how specific it looks. Terms whose canonical form is
 * already spelled correctly in the transcript are still included, because the model
 * needs to know not to "fix" them.
 */
export function selectGlossary(
  terms: readonly DictionaryTerm[],
  transcript: string,
  maxTerms: number,
): GlossarySelection {
  if (maxTerms <= 0) return { entries: [], omitted: 0 };

  const haystack = normalizeForMatch(transcript);
  const scored: Array<{ term: DictionaryTerm; score: number }> = [];

  for (const term of terms) {
    if (!term.enabled) continue;

    let score = 0;
    const canonicalNorm = normalizeForMatch(term.canonical);
    if (canonicalNorm.length > 0 && haystack.includes(canonicalNorm)) {
      score += 100;
    }
    for (const alias of term.aliases) {
      const aliasNorm = normalizeForMatch(alias);
      if (aliasNorm.length === 0) continue;
      // An ambiguous alias must not pull its term into the prompt either. The denylist
      // exists because words like "компонент" are ordinary Russian, not a mangled English
      // identifier; if we still hand the model `component`, it performs exactly the
      // substitution the deterministic pass refused to make and the sentence ends up as
      // "вот этот component слишком большой". Skipping the hit keeps both paths agreeing.
      if (AMBIGUOUS_ALIAS_DENYLIST.has(aliasNorm)) continue;
      if (haystack.includes(aliasNorm)) {
        // Longer alias hits are stronger evidence than incidental short ones.
        score += 80 + Math.min(aliasNorm.length, 20);
      }
    }
    // Multi-word canonical forms are the ones STT most often splits or mangles, so they
    // win ties — but only among terms that actually matched. Adding this unconditionally
    // would give every multi-word term a nonzero score and leak it into the prompt.
    if (score > 0 && term.canonical.includes(" ")) score += 2;
    // Same reasoning for priority: it breaks ties between terms that already matched,
    // so when more terms match than `maxTerms` allows, the everyday ones survive the cut.
    if (score > 0) score += Math.min(term.priority ?? 0, 10);
    scored.push({ term, score });
  }

  const matched = scored.filter((item) => item.score > 0);
  matched.sort((a, b) => b.score - a.score || a.term.canonical.localeCompare(b.term.canonical));

  const selected = matched.slice(0, maxTerms);
  const omitted = Math.max(0, matched.length - selected.length);

  return {
    entries: selected.map(({ term }) => ({
      canonical: term.canonical,
      aliases: [...term.aliases],
    })),
    omitted,
  };
}

/**
 * Builds the short hint handed to Whisper as `initial_prompt`.
 *
 * Whisper's prompt window is small and a long prompt measurably degrades recognition,
 * so only canonical forms go in, capped by character budget. A dictionary of a few
 * hundred terms overflows that budget many times over, and the callers hand terms over
 * in alphabetical order — without ranking, the hint would be whatever happens to sort
 * first ("API … SQLite") and every `use*` hook would fall off the end. `priority`
 * therefore decides who gets a slot; ties keep the caller's order, so the hint stays
 * byte-identical between requests (stable prompts keep decoding deterministic).
 */
export function buildSttInitialPrompt(
  terms: readonly DictionaryTerm[],
  charLimit: number,
): string {
  if (charLimit <= 0) return "";

  const parts: string[] = [];
  let used = 0;

  // Array.prototype.sort is stable, so equal priorities preserve the incoming order.
  const ranked = [...terms].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const term of ranked) {
    if (!term.enabled) continue;
    const canonical = term.canonical.trim();
    if (canonical.length === 0) continue;
    const cost = canonical.length + (parts.length > 0 ? 2 : 0);
    if (used + cost > charLimit) continue;
    parts.push(canonical);
    used += cost;
  }

  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Deterministic replacement
// ---------------------------------------------------------------------------

export interface ReplacementHit {
  alias: string;
  canonical: string;
  index: number;
}

export interface ReplacementResult {
  text: string;
  hits: ReplacementHit[];
  /** Aliases skipped as too short or too ambiguous to replace safely. */
  skipped: string[];
}

interface CompiledAlias {
  alias: string;
  canonical: string;
  normalized: string;
}

function isSafeAlias(alias: string): boolean {
  const trimmed = alias.trim();
  if (trimmed.length < MIN_DETERMINISTIC_ALIAS_LENGTH) return false;
  if (AMBIGUOUS_ALIAS_DENYLIST.has(normalizeForMatch(trimmed))) return false;
  return true;
}

/**
 * Conservatively rewrites unambiguous aliases to their canonical form.
 *
 * This runs *before* the LLM and is intentionally timid: it only fires on whole-word
 * matches of aliases that are long enough and not common words. Anything doubtful is
 * left alone and handed to the model as glossary context instead — losing a correction
 * is cheap, corrupting the user's words is not.
 */
export function applyDeterministicReplacements(
  text: string,
  terms: readonly DictionaryTerm[],
): ReplacementResult {
  const skipped: string[] = [];
  const compiled: CompiledAlias[] = [];

  for (const term of terms) {
    if (!term.enabled) continue;
    for (const alias of term.aliases) {
      const trimmed = alias.trim();
      if (trimmed.length === 0) continue;
      // Case-only pairs (alias differs from the canonical form only in casing) get no
      // exemption here: canonical "OR" with alias "or" would otherwise rewrite every
      // ordinary "or" in every dictation. Long identifiers like "javascript" still get
      // their casing fixed, because they pass the guards on their own.
      if (!isSafeAlias(trimmed)) {
        skipped.push(trimmed);
        continue;
      }
      compiled.push({
        alias: trimmed,
        canonical: term.canonical,
        normalized: normalizeForMatch(trimmed),
      });
    }
  }

  // Longest alias first, so "реакт квери" beats "реакт".
  compiled.sort((a, b) => b.normalized.length - a.normalized.length);

  const hits: ReplacementHit[] = [];
  // NFC can merge characters (decomposed "и" + breve becomes a single "й"), so indices
  // found in a normalized haystack do not line up with the raw input. All matching and
  // slicing below therefore runs on one NFC copy of the text, never on `text` itself.
  const source = text.normalize("NFC");
  const haystack = normalizeForMatch(source);
  // Locale-aware lowercasing can still change the length for exotic characters ("İ"
  // lowercases to two code units); slices would then land on the wrong positions, so
  // the deterministic pass honestly stands down instead of corrupting the text.
  if (haystack.length !== source.length) {
    return { text, hits, skipped };
  }
  // `taken` marks output positions already rewritten, so a shorter alias cannot
  // chew into a longer replacement that already fired.
  const taken: boolean[] = new Array(source.length).fill(false);

  // Replacements are collected as (start, end, canonical) and applied once at the end,
  // which keeps every index referring to the original string.
  const edits: Array<{ start: number; end: number; canonical: string; alias: string }> = [];

  for (const entry of compiled) {
    if (entry.normalized.length === 0) continue;
    let from = 0;
    for (;;) {
      const idx = haystack.indexOf(entry.normalized, from);
      if (idx === -1) break;
      const end = idx + entry.normalized.length;
      from = idx + 1;

      // Whole-word only: never rewrite a fragment of a longer word.
      if (isWordChar(source[idx - 1]) || isWordChar(source[end])) continue;
      // Do not overlap an edit that already claimed this span.
      let overlaps = false;
      for (let i = idx; i < end; i += 1) {
        if (taken[i]) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      for (let i = idx; i < end; i += 1) taken[i] = true;
      edits.push({ start: idx, end, canonical: entry.canonical, alias: entry.alias });
    }
  }

  if (edits.length === 0) {
    return { text, hits, skipped };
  }

  edits.sort((a, b) => a.start - b.start);

  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    // A match identical to the canonical form (including case) is not an edit.
    if (source.slice(edit.start, edit.end) === edit.canonical) continue;
    out += source.slice(cursor, edit.start);
    out += edit.canonical;
    cursor = edit.end;
    hits.push({ alias: edit.alias, canonical: edit.canonical, index: edit.start });
  }
  // Every candidate turned out to already be canonical: return the input byte-identical
  // rather than a silently NFC-normalized copy of it.
  if (hits.length === 0) {
    return { text, hits, skipped };
  }
  out += source.slice(cursor);

  return { text: out, hits, skipped };
}
