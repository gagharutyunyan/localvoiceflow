import { z } from "zod";

export const TermLanguageSchema = z.enum(["ru", "en", "mixed"]);
export type TermLanguage = z.infer<typeof TermLanguageSchema>;

export const DictionaryTermSchema = z.object({
  id: z.string().min(1).max(64),
  canonical: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(64).default([]),
  category: z.string().trim().max(80).optional(),
  language: TermLanguageSchema.optional(),
  notes: z.string().max(2000).optional(),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DictionaryTerm = z.infer<typeof DictionaryTermSchema>;

export const DictionaryTermInputSchema = z.object({
  canonical: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(64).default([]),
  category: z.string().trim().max(80).optional().nullable(),
  language: TermLanguageSchema.optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  enabled: z.boolean().default(true),
});

export type DictionaryTermInput = z.infer<typeof DictionaryTermInputSchema>;

export const DictionaryTermPatchSchema = DictionaryTermInputSchema.partial();
export type DictionaryTermPatch = z.infer<typeof DictionaryTermPatchSchema>;

/** Payload accepted by JSON import; CSV is parsed server-side into this shape. */
export const DictionaryImportSchema = z.object({
  terms: z.array(DictionaryTermInputSchema).max(5000),
  mode: z.enum(["merge", "replace"]).default("merge"),
});
export type DictionaryImport = z.infer<typeof DictionaryImportSchema>;

/**
 * Uniqueness key for a canonical form.
 *
 * SQLite's `NOCASE` collation only folds ASCII, so "Уникальный" and "уникальный" would
 * both be accepted as distinct rows. Case folding therefore happens in JS, and the result
 * is what carries the UNIQUE index.
 */
export function canonicalKey(canonical: string): string {
  return canonical.normalize("NFC").trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

/**
 * An alias shorter than this is never used for deterministic replacement, because
 * short strings collide with ordinary Russian/English words far too often.
 * It is still sent to the LLM as glossary context.
 */
export const MIN_DETERMINISTIC_ALIAS_LENGTH = 5;

/**
 * Aliases that are real, common words in Russian — mostly naturalised loanwords that
 * decline or conjugate. Replacing these corrupts ordinary speech: "компонент" becomes
 * "вот этот component слишком большой", and the verb "инвалидировать" becomes the bare
 * English infinitive in "нужно invalidate Query".
 *
 * A denylisted alias is skipped by the deterministic pass *and* withheld from the
 * glossary sent to the model. Suppressing only the deterministic pass was not enough:
 * handing the model the canonical form made it perform the very substitution the
 * deterministic pass had refused, so both paths now honour this list.
 *
 * A term is still selected when its canonical form appears in the transcript verbatim,
 * so the model is told not to "fix" text that is already correct.
 */
export const AMBIGUOUS_ALIAS_DENYLIST: ReadonlySet<string> = new Set([
  "состояние",
  "компонент",
  "крючок",
  "реквизит",
  "точка",
  "конец",
  "интерфейс",
  "запрос",
  "ответ",
  "стейт",
  "хук",
  "апи",
  "гит",
  "вид",
  "форма",
  "поле",
  "путь",
  "код",
  "тип",
  "стиль",
  "мутация",
  "инвалидировать",
]);
