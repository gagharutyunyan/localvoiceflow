import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AMBIGUOUS_ALIAS_DENYLIST,
  MIN_DETERMINISTIC_ALIAS_LENGTH,
  canonicalKey,
} from "../dist/dictionary.js";
import { SEED_DICTIONARY } from "../dist/seed-dictionary.js";
import { applyDeterministicReplacements, buildSttInitialPrompt } from "../dist/glossary.js";
import { defaultSettings } from "../dist/settings.js";
import type { DictionaryTerm } from "../dist/dictionary.js";

function normalize(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

/** The seed as the pipeline sees it: rows straight out of the table, alphabetically. */
const TERMS: DictionaryTerm[] = SEED_DICTIONARY.map((term, index) => ({
  id: `seed-${index}`,
  canonical: term.canonical,
  aliases: term.aliases,
  enabled: term.enabled,
  priority: term.priority,
  ...(term.category ? { category: term.category } : {}),
  ...(term.language ? { language: term.language } : {}),
  ...(term.notes ? { notes: term.notes } : {}),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
})).sort((a, b) => a.canonical.localeCompare(b.canonical));

describe("seed dictionary integrity", () => {
  test("no two terms share a canonical key", () => {
    const seen = new Map<string, string>();
    for (const term of SEED_DICTIONARY) {
      const key = canonicalKey(term.canonical);
      assert.equal(seen.get(key), undefined, `"${term.canonical}" duplicates "${seen.get(key)}"`);
      seen.set(key, term.canonical);
    }
  });

  test("no alias is claimed by two terms, or is another term's canonical form", () => {
    const canonicalKeys = new Map(
      SEED_DICTIONARY.map((term) => [canonicalKey(term.canonical), term.canonical]),
    );
    const owners = new Map<string, string>();
    for (const term of SEED_DICTIONARY) {
      for (const alias of term.aliases) {
        const key = normalize(alias);
        assert.equal(
          owners.get(key),
          undefined,
          `alias "${alias}" is on both "${term.canonical}" and "${owners.get(key)}"`,
        );
        owners.set(key, term.canonical);

        const clash = canonicalKeys.get(canonicalKey(alias));
        if (clash !== undefined && canonicalKey(alias) !== canonicalKey(term.canonical)) {
          assert.fail(`alias "${alias}" of "${term.canonical}" is the canonical form of "${clash}"`);
        }
      }
    }
  });

  test("aliases are lower-case, so the ordinary spoken form is what gets matched", () => {
    for (const term of SEED_DICTIONARY) {
      for (const alias of term.aliases) {
        assert.equal(alias, alias.toLocaleLowerCase("ru-RU"), `alias "${alias}" is not lower-case`);
        assert.equal(alias, alias.trim(), `alias "${alias}" has stray whitespace`);
      }
    }
  });

  test("every priority-5 term fits the default Whisper prompt budget", () => {
    // The whole point of `priority` is that the terms marked "must be in the hint" are
    // actually in it at the shipped budget. Adding a 23rd one has to be a conscious act.
    const prompt = buildSttInitialPrompt(TERMS, defaultSettings().stt.glossaryPromptLimit);
    for (const term of SEED_DICTIONARY) {
      if (term.priority !== 5) continue;
      assert.ok(prompt.includes(term.canonical), `"${term.canonical}" fell out of the STT hint`);
    }
  });

  test("the hint never leaks an alias — Whisper would start spelling them out", () => {
    const prompt = normalize(buildSttInitialPrompt(TERMS, 896));
    for (const term of SEED_DICTIONARY) {
      for (const alias of term.aliases) {
        if (canonicalKey(alias) === canonicalKey(term.canonical)) continue;
        assert.ok(!prompt.includes(normalize(alias)), `alias "${alias}" leaked into the hint`);
      }
    }
  });
});

describe("seed dictionary behaviour on real speech", () => {
  const CORRECTED: Array<[string, string[]]> = [
    ["открой клод код и включи план мод", ["Claude Code", "plan mode"]],
    ["это не код-дизайн а обычный клод дизайн", ["Claude Design"]],
    ["юз эффект снова вызывает фетч когда меняется юзер дата", ["useEffect", "userData"]],
    ["добавь аборт контроллер и отмени запрос в клинапе юз эффекта", ["AbortController", "cleanup", "useEffect"]],
    ["перейди в папку фронтенд и запусти пи эн пи эм", ["frontend", "pnpm"]],
    ["назови переменную в кэмел кейс а файл в кебаб кейс", ["camelCase", "kebab-case"]],
    ["запусти вайтест потом эслинт и преттиер", ["Vitest", "ESLint", "Prettier"]],
    ["в вебшторме открой мейкфайл", ["WebStorm", "Makefile"]],
    ["опиши эм си пи сервер для сабагента", ["MCP server", "subagent"]],
    ["сделай пулл реквест и потом ребейз", ["pull request", "rebase"]],
    ["напиши экран на свифт юай и собери в икскод", ["SwiftUI", "Xcode"]],
  ];

  for (const [spoken, expected] of CORRECTED) {
    test(`corrects: ${spoken}`, () => {
      const { text } = applyDeterministicReplacements(spoken, TERMS);
      for (const canonical of expected) {
        assert.ok(text.includes(canonical), `expected "${canonical}" in "${text}"`);
      }
    });
  }

  // Rule 3 of the alias contract: a correct Russian sentence must survive untouched.
  const UNTOUCHED = [
    "мне нужно и ту и другую версию посмотреть",
    "утечка памяти появилась после релиза",
    "гонка состояний тут вполне вероятна",
    "сделай ленивую загрузку картинок на главной",
    "внедрение зависимостей здесь избыточно",
    "нужна пагинация на списке пользователей",
    "линтер ругается на неиспользуемую переменную",
    "состояние компонента не обновляется после мутации",
    "поток данных идёт через очередь сообщений",
    "сборка мебели заняла весь вечер",
    "поставь ветку в вазу с водой",
    "реактивный подход к состоянию не меняем",
  ];

  for (const spoken of UNTOUCHED) {
    test(`leaves alone: ${spoken}`, () => {
      const { text, hits } = applyDeterministicReplacements(spoken, TERMS);
      assert.deepEqual(hits, [], `unexpected rewrite: ${text}`);
      assert.equal(text, spoken);
    });
  }

  test("short and denylisted aliases are never substituted, only offered to the model", () => {
    const { skipped } = applyDeterministicReplacements("любой текст", TERMS);
    for (const alias of skipped) {
      const tooShort = alias.length < MIN_DETERMINISTIC_ALIAS_LENGTH;
      const denied = AMBIGUOUS_ALIAS_DENYLIST.has(normalize(alias));
      assert.ok(tooShort || denied, `"${alias}" was skipped for no stated reason`);
    }
  });
});
