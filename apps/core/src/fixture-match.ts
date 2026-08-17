/**
 * Term matching for the transcription fixtures, shared by the benchmark and the smoke test.
 *
 * Fixtures never assert string equality — the model is free to rephrase a sentence, so the
 * check is whether the meaning-bearing terms survived the edit.
 */

/**
 * Does the edited text still carry this term?
 *
 * Identifiers are matched exactly: "useEffect" must not pass as "useeffect", because the
 * casing is the whole point of correcting them. An ordinary word is matched
 * case-insensitively, because whether it lands at the start of a sentence is the model's
 * choice: dropping a leading "Этот" legitimately turns "компонент" into "Компонент", and
 * failing on that reports correct output as a regression.
 *
 * The two are told apart by an interior capital — camelCase and PascalCase have one, plain
 * Russian and English words do not.
 */
export function containsTerm(haystack: string, needle: string): boolean {
  const isIdentifier = /[A-Z]/.test(needle.slice(1));
  if (isIdentifier) return haystack.includes(needle);
  return haystack.toLocaleLowerCase("ru-RU").includes(needle.toLocaleLowerCase("ru-RU"));
}

/**
 * Did a term that should have been edited away survive?
 *
 * Always case-insensitive: a leak is a leak whether the model wrote "юз эффект" or
 * "Юз эффект", and the stricter reading is the safer one for a negative assertion.
 */
export function leaksTerm(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase("ru-RU").includes(needle.toLocaleLowerCase("ru-RU"));
}
