import type { DictionaryTermInput } from "./dictionary.js";

/**
 * Editable starting dictionary.
 *
 * Aliases are the shapes Whisper actually produces for Russian speech containing these
 * English terms (verified against real transcripts where possible). Deliberately absent
 * are short or common-word aliases — `applyDeterministicReplacements` would refuse them
 * anyway, and listing them here would only inflate the LLM prompt.
 */
export const SEED_DICTIONARY: readonly DictionaryTermInput[] = [
  // --- Core languages / runtimes ---
  { canonical: "React", aliases: ["реакт", "риэкт"], category: "Frontend", language: "mixed", enabled: true },
  { canonical: "TypeScript", aliases: ["тайпскрипт", "тайп скрипт", "type script"], category: "Language", language: "mixed", enabled: true },
  { canonical: "JavaScript", aliases: ["джаваскрипт", "джава скрипт", "жаваскрипт", "java script"], category: "Language", language: "mixed", enabled: true },
  { canonical: "Node.js", aliases: ["нода", "ноуд джей эс", "node js", "нод джс"], category: "Runtime", language: "mixed", enabled: true },

  // --- Data fetching / state ---
  { canonical: "React Query", aliases: ["реакт квери", "react query", "реакт-квери", "реакт кьюери"], category: "Frontend", language: "mixed", enabled: true },
  { canonical: "TanStack Query", aliases: ["танстак квери", "тан стак квери", "tanstack query"], category: "Frontend", language: "mixed", enabled: true },
  { canonical: "Redux Toolkit", aliases: ["редакс тулкит", "редукс тулкит", "redux toolkit"], category: "Frontend", language: "mixed", enabled: true },
  { canonical: "Zustand", aliases: ["зустанд", "цустанд"], category: "Frontend", language: "mixed", enabled: true },

  // --- React hooks ---
  { canonical: "useEffect", aliases: ["юз эффект", "use effect", "юзэффект", "юз-эффект"], category: "React", language: "mixed", enabled: true },
  { canonical: "useMemo", aliases: ["юз мемо", "use memo", "юзмемо"], category: "React", language: "mixed", enabled: true },
  { canonical: "useCallback", aliases: ["юз колбэк", "юз коллбэк", "use callback", "юз колбек"], category: "React", language: "mixed", enabled: true },
  { canonical: "useRef", aliases: ["юз реф", "use ref", "юзреф"], category: "React", language: "mixed", enabled: true },
  { canonical: "useState", aliases: ["юз стейт", "use state", "юзстейт"], category: "React", language: "mixed", enabled: true },
  { canonical: "useQuery", aliases: ["юз квери", "use query", "юзквери"], category: "React", language: "mixed", enabled: true },
  { canonical: "useMutation", aliases: ["юз мутейшн", "use mutation", "юз мутация"], category: "React", language: "mixed", enabled: true },

  // --- Forms / UI ---
  { canonical: "Formik", aliases: ["формик"], category: "Frontend", language: "mixed", enabled: true },
  { canonical: "Yup", aliases: ["яп схема", "yup"], category: "Frontend", language: "mixed", enabled: true },
  { canonical: "MUI", aliases: ["эм ю ай", "материал юай", "material ui"], category: "Frontend", language: "mixed", enabled: true },
  { canonical: "SCSS", aliases: ["эс си эс эс", "сасс", "sass"], category: "Frontend", language: "mixed", enabled: true },
  { canonical: "Tailwind", aliases: ["тейлвинд", "тэйлвинд", "тайлвинд"], category: "Frontend", language: "mixed", enabled: true },

  // --- Tooling ---
  { canonical: "Vite", aliases: ["вите", "вайт билдер", "вайти"], category: "Tooling", language: "mixed", enabled: true },
  { canonical: "WebStorm", aliases: ["вебшторм", "веб шторм", "web storm"], category: "Tooling", language: "mixed", enabled: true },
  { canonical: "Axios", aliases: ["аксиос", "аксиус", "аксиос запрос"], category: "Networking", language: "mixed", enabled: true },
  { canonical: "Docker", aliases: ["докер", "доккер"], category: "DevOps", language: "mixed", enabled: true },
  { canonical: "Git", aliases: ["гит"], category: "DevOps", language: "mixed", enabled: true },
  { canonical: "GitHub", aliases: ["гитхаб", "гит хаб", "гит-хаб"], category: "DevOps", language: "mixed", enabled: true },
  { canonical: "pnpm", aliases: ["пи эн пи эм", "пэ эн пэ эм", "пнпм"], category: "Tooling", language: "mixed", enabled: true },
  { canonical: "npm", aliases: ["эн пи эм", "нпм"], category: "Tooling", language: "mixed", enabled: true },
  { canonical: "ESLint", aliases: ["ислинт", "и эс линт", "эслинт"], category: "Tooling", language: "mixed", enabled: true },

  // --- Backend ---
  { canonical: "Laravel", aliases: ["ларавел", "ларавель", "ларавэль"], category: "Backend", language: "mixed", enabled: true },
  { canonical: "PostgreSQL", aliases: ["постгрес", "постгрескл", "постгре"], category: "Backend", language: "mixed", enabled: true },
  { canonical: "SQLite", aliases: ["скюлайт", "эс кью лайт", "сиквелайт"], category: "Backend", language: "mixed", enabled: true },
  { canonical: "API", aliases: ["эй пи ай", "апишка"], category: "General", language: "mixed", enabled: true },
  { canonical: "REST", aliases: ["рест апи", "рест-апи"], category: "Backend", language: "mixed", enabled: true },

  // --- Generic concepts (aliases kept long enough to be safe) ---
  { canonical: "frontend", aliases: ["фронтенд", "фронт энд", "фронт-энд"], category: "General", language: "mixed", enabled: true },
  { canonical: "backend", aliases: ["бэкенд", "бекенд", "бэк энд", "бэк-энд"], category: "General", language: "mixed", enabled: true },
  { canonical: "props", aliases: ["пропсы", "пропсах", "пропсов", "пропсами"], category: "React", language: "mixed", enabled: true },
  { canonical: "state", aliases: ["стейт"], category: "React", language: "mixed", enabled: true },
  { canonical: "hook", aliases: ["хук"], category: "React", language: "mixed", enabled: true },
  // No "компонент" → "component" entry on purpose: it is an ordinary Russian noun that
  // declines, so forcing the English form yields "вот этот component слишком большой".
  // The same reasoning keeps "мутация" and "инвалидировать" out — see the denylist.
  { canonical: "endpoint", aliases: ["эндпоинт", "энд поинт", "эндпойнт"], category: "Backend", language: "mixed", enabled: true },
  { canonical: "fetch", aliases: ["фетч", "фечь", "фэтч"], category: "Networking", language: "mixed", enabled: true },
  { canonical: "AbortController", aliases: ["аборт контроллер", "abort controller", "эборт контроллер"], category: "Networking", language: "mixed", enabled: true },
  { canonical: "cleanup", aliases: ["клинап", "клин ап", "клинапе"], category: "React", language: "mixed", enabled: true },
  { canonical: "userData", aliases: ["юзер дата", "user data", "юзердата"], category: "Identifiers", language: "mixed", enabled: true },
  { canonical: "userId", aliases: ["юзер айди", "user id", "юзер ид"], category: "Identifiers", language: "mixed", enabled: true },
  { canonical: "UserProfile", aliases: ["юзер профайл", "user profile", "юзер профиль"], category: "Identifiers", language: "mixed", enabled: true },
  { canonical: "invalidate", aliases: ["инвалидейт"], category: "Frontend", language: "mixed", enabled: true },
  { canonical: "mutation", aliases: ["мутейшн"], category: "Frontend", language: "mixed", enabled: true },

  // --- AI tooling ---
  { canonical: "Claude Code", aliases: ["клод код", "клауд код", "cloud code", "клод-код"], category: "AI", language: "mixed", enabled: true },
  { canonical: "Codex", aliases: ["кодекс", "кодэкс"], category: "AI", language: "mixed", enabled: true },
  { canonical: "GPT", aliases: ["джи пи ти", "гпт"], category: "AI", language: "mixed", enabled: true },
  { canonical: "Opus", aliases: ["опус"], category: "AI", language: "mixed", enabled: true },
  { canonical: "Sonnet", aliases: ["соннет", "сонет"], category: "AI", language: "mixed", enabled: true },
  { canonical: "Haiku", aliases: ["хайку"], category: "AI", language: "mixed", enabled: true },
  { canonical: "Whisper", aliases: ["виспер", "уиспер"], category: "AI", language: "mixed", enabled: true },

  // --- Personal projects ---
  { canonical: "PayAtTable", aliases: ["пей эт тейбл", "пэй эт тэйбл", "pay at table"], category: "Projects", language: "mixed", enabled: true },
  { canonical: "YapYap", aliases: ["яп яп", "яп-яп", "yap yap"], category: "Projects", language: "mixed", enabled: true },
];
