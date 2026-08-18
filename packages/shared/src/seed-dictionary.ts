import type { DictionaryTermInput, TermLanguage } from "./dictionary.js";

/**
 * A row as written by hand below. Everything but `canonical` is optional; the defaults
 * applied at the bottom of this file turn it into a full `DictionaryTermInput`.
 */
interface SeedTerm {
  canonical: string;
  /**
   * The shapes Whisper actually produces for Russian speech containing this term.
   *
   * Two rules keep this list honest:
   *
   * 1. An alias is only worth writing down if replacing it with the canonical form
   *    improves the sentence. Naturalised loanwords that decline ("коммит", "ветка",
   *    "деплой", "кэш") are deliberately absent: rewriting them to English breaks the
   *    Russian grammar around them, and `AMBIGUOUS_ALIAS_DENYLIST` blocks the worst of
   *    them anyway.
   * 2. Inflected forms have to be spelled out. Replacement is whole-word, so the alias
   *    "юз эффект" does not match "юз эффекта" — the case ending has to be its own alias
   *    whenever that form is common in speech.
   * 3. A Russian *translation* is never an alias. "утечка памяти" as an alias of
   *    `memory leak` would translate correct Russian into English mid-sentence, which is
   *    the one thing the dictation must never do. Only mishearings and transliterations
   *    belong here.
   * 4. An alias must not be a phrase whose tail the canonical form drops: "пип инсталл"
   *    → `pip` silently eats the verb and "pip реквестс" comes out instead of
   *    "pip install requests".
   *
   * Aliases shorter than `MIN_DETERMINISTIC_ALIAS_LENGTH` are never substituted, but they
   * are not useless: they still pull their term into the glossary sent to the model.
   */
  aliases?: string[];
  category?: string;
  language?: TermLanguage;
  notes?: string;
  /**
   * Slot in Whisper's `initial_prompt`, 0–5 here (the schema allows up to 100).
   *
   * The prompt budget fits roughly 20 terms, so only 5 means "must be in the hint".
   * Everything below that is corrected after the fact, by the deterministic pass or by
   * the model, and loses nothing by being absent from the hint.
   */
  priority?: number;
}

/**
 * Editable starting dictionary, aimed at one specific person: a Russian-speaking
 * developer dictating into Claude Code inside the WebStorm terminal.
 *
 * That target explains the shape of the list. Library and tool names dominate, because
 * those are what Whisper mangles and what has to come out spelled exactly right for a
 * command to work. Ordinary Russian technical vocabulary ("компонент", "запрос",
 * "очередь") is deliberately left alone — see the alias rules above.
 */
const RAW_SEED: readonly SeedTerm[] = [
  // ===========================================================================
  // Claude & AI tooling — the vocabulary of the app being dictated into.
  // ===========================================================================
  { canonical: "Claude Code", aliases: ["клод код", "клауд код", "cloud code", "клод-код", "клод коде", "клод кода", "клоуд код"], category: "Claude", priority: 5 },
  // Heard as "код-дизайн" far more often than as a product name: Whisper hears the
  // English "Claude" as the Russian "код"/"клауд" and then happily builds a compound.
  { canonical: "Claude Design", aliases: ["клод дизайн", "клауд дизайн", "код дизайн", "код-дизайн", "клод-дизайн", "cloud design", "клоуд дизайн"], category: "Claude", priority: 5 },
  { canonical: "Claude", aliases: ["клод", "клауд", "клоуд"], category: "Claude", priority: 4, notes: "Короткие алиасы работают только как подсказка модели: заменять их детерминистически слишком рискованно." },
  { canonical: "Anthropic", aliases: ["антропик", "энтропик", "антропика", "антропике", "антропиком"], category: "Claude", priority: 3 },
  { canonical: "CLAUDE.md", aliases: ["клод эм ди", "клод мд", "claude md", "клод точка эм ди", "клод маркдаун"], category: "Claude", priority: 3 },
  { canonical: "MCP", aliases: ["эм си пи", "мцп", "эмсипи", "эм-си-пи"], category: "Claude", priority: 5 },
  { canonical: "MCP server", aliases: ["эм си пи сервер", "мцп сервер", "эмсипи сервер"], category: "Claude", priority: 2 },
  { canonical: "Model Context Protocol", aliases: ["модел контекст протокол", "модель контекст протокол"], category: "Claude", priority: 1 },
  { canonical: "subagent", aliases: ["сабагент", "саб агент", "суб агент", "сабагента", "сабагенту", "сабагенты", "сабагентов", "сабэджент"], category: "Claude", priority: 3 },
  { canonical: "ultrathink", aliases: ["ультратинк", "ультра тинк", "ультрасинк", "ультра синк", "ультра финк"], category: "Claude", priority: 3 },
  { canonical: "plan mode", aliases: ["план мод", "плэн мод", "плен мод"], category: "Claude", priority: 2 },
  { canonical: "slash command", aliases: ["слэш команда", "слеш команда", "слэш-команда", "слеш-команда"], category: "Claude", priority: 1 },
  { canonical: "skill", aliases: ["скиллы клода"], category: "Claude", priority: 1 },
  { canonical: "artifact", aliases: ["артифакт"], category: "Claude", priority: 1 },
  { canonical: "--dangerously-skip-permissions", aliases: ["дэнджерасли скип пермишенс", "денджерасли скип пермишн", "дэнжерасли скип пермишенс", "скип пермишенс", "скип пермишнс"], category: "Claude", priority: 0 },
  { canonical: "Codex", aliases: ["кодекс", "кодэкс"], category: "AI", priority: 2 },
  { canonical: "GPT", aliases: ["джи пи ти", "гпт", "джипити"], category: "AI", priority: 2 },
  { canonical: "ChatGPT", aliases: ["чат джи пи ти", "чатгпт", "чат гпт"], category: "AI", priority: 2 },
  { canonical: "Gemini", aliases: ["джемини", "гемини", "джеминай"], category: "AI", priority: 1 },
  { canonical: "Copilot", aliases: ["копайлот", "копилот", "ко пайлот"], category: "AI", priority: 1 },
  { canonical: "Opus", aliases: ["опус", "опусе", "опусом"], category: "AI", priority: 3 },
  { canonical: "Sonnet", aliases: ["соннет", "сонет", "соннете", "сонете"], category: "AI", priority: 3 },
  { canonical: "Haiku", aliases: ["хайку", "хаику"], category: "AI", priority: 3 },
  { canonical: "LLM", aliases: ["эл эл эм", "элэлэм"], category: "AI", priority: 2 },
  { canonical: "Whisper", aliases: ["виспер", "уиспер", "виспера", "виспере", "уисперу"], category: "AI", priority: 5 },
  { canonical: "MLX", aliases: ["эм эл икс", "эмэликс"], category: "AI", priority: 3 },
  { canonical: "Hugging Face", aliases: ["хаггинг фейс", "хагинг фейс", "хаггин фейс"], category: "AI", priority: 1 },
  { canonical: "Ollama", aliases: ["оллама", "олама"], category: "AI", priority: 1 },
  { canonical: "Qwen", aliases: ["квен", "кьювен", "куэн"], category: "AI", priority: 1 },
  { canonical: "embedding", aliases: ["эмбеддинг", "эмбединг", "эмбеддинги"], category: "AI", priority: 1 },
  { canonical: "RAG", aliases: [], category: "AI", priority: 0 },
  { canonical: "structured output", aliases: ["структурд аутпут", "структурный аутпут"], category: "AI", priority: 1 },
  { canonical: "system prompt", aliases: ["систем промпт", "системный промпт"], category: "AI", priority: 1 },
  { canonical: "few-shot", aliases: ["фью шот", "фью-шот"], category: "AI", priority: 0 },
  { canonical: "STT", aliases: ["эс ти ти", "эстити"], category: "AI", priority: 1 },
  { canonical: "TTS", aliases: ["ти ти эс", "титиэс"], category: "AI", priority: 0 },

  // ===========================================================================
  // Languages
  // ===========================================================================
  { canonical: "TypeScript", aliases: ["тайпскрипт", "тайп скрипт", "type script", "тайпскрипте", "тайпскрипта", "тайпскрипту"], category: "Language", priority: 5 },
  { canonical: "JavaScript", aliases: ["джаваскрипт", "джава скрипт", "жаваскрипт", "java script", "джаваскрипте", "джаваскрипта"], category: "Language", priority: 4 },
  { canonical: "Python", aliases: ["питон", "пайтон", "питоне", "питона", "пайтоне"], category: "Language", priority: 4 },
  { canonical: "Swift", aliases: ["свифт", "свифте", "свифта", "суифт"], category: "Language", priority: 4 },
  { canonical: "Go", aliases: ["голанг", "гоу ланг", "го лэнг", "голанге"], category: "Language", priority: 2 },
  { canonical: "Rust", aliases: ["раст", "расте", "раста"], category: "Language", priority: 2, notes: "«Раст» — распространённое сокращение; в русской речи почти всегда именно язык." },
  { canonical: "Kotlin", aliases: ["котлин", "котлине"], category: "Language", priority: 1 },
  { canonical: "Java", aliases: ["джава", "ява", "джаве"], category: "Language", priority: 1 },
  { canonical: "PHP", aliases: ["пи эйч пи", "пэхэпэ", "пхп"], category: "Language", priority: 2 },
  { canonical: "Ruby", aliases: ["руби", "раби"], category: "Language", priority: 0 },
  { canonical: "C++", aliases: ["си плюс плюс", "сиплюсплюс"], category: "Language", priority: 1 },
  { canonical: "C#", aliases: ["си шарп", "сишарп"], category: "Language", priority: 0 },
  { canonical: "SQL", aliases: ["эс кью эль", "сиквел", "скуль"], category: "Language", priority: 2 },
  { canonical: "Bash", aliases: ["баш", "баше", "бэш"], category: "Shell", priority: 2 },
  { canonical: "Zsh", aliases: ["зэш", "зет эс эйч", "зшелл"], category: "Shell", priority: 1 },
  { canonical: "HTML", aliases: ["эйч ти эм эль", "хтмл", "html"], category: "Frontend", priority: 2 },
  { canonical: "CSS", aliases: ["си эс эс", "цсс"], category: "Frontend", priority: 2 },
  { canonical: "SCSS", aliases: ["эс си эс эс", "сасс", "sass"], category: "Frontend", priority: 2 },
  { canonical: "JSON", aliases: ["джейсон", "жсон", "джсон", "джейсоне", "джейсона"], category: "Data", priority: 3 },
  { canonical: "YAML", aliases: ["ямл", "яамл", "яэмэль"], category: "Data", priority: 2 },
  { canonical: "TOML", aliases: ["томл", "то эм эль"], category: "Data", priority: 1 },
  { canonical: "XML", aliases: ["икс эм эль", "иксэмэль"], category: "Data", priority: 1 },
  { canonical: "Markdown", aliases: ["маркдаун", "маркдауне", "марк даун"], category: "Data", priority: 2 },
  { canonical: "GraphQL", aliases: ["графкуэль", "граф кью эль", "графql", "графкьюэл"], category: "Backend", priority: 2 },
  { canonical: "regex", aliases: ["регэксп", "регексп", "регулярка", "регулярку", "регулярке"], category: "Concepts", priority: 1 },

  // ===========================================================================
  // Runtimes & package managers
  // ===========================================================================
  { canonical: "Node.js", aliases: ["нода", "ноуд джей эс", "node js", "нод джс", "ноде", "ноды"], category: "Runtime", priority: 5 },
  { canonical: "Deno", aliases: ["дено", "дэно"], category: "Runtime", priority: 0 },
  { canonical: "Bun", aliases: ["бан рантайм", "бун рантайм"], category: "Runtime", priority: 0 },
  { canonical: "pnpm", aliases: ["пи эн пи эм", "пэ эн пэ эм", "пнпм", "пенпеэм"], category: "Tooling", priority: 5 },
  { canonical: "npm", aliases: ["эн пи эм", "нпм"], category: "Tooling", priority: 4 },
  { canonical: "npx", aliases: ["эн пи икс", "нпикс"], category: "Tooling", priority: 2 },
  { canonical: "yarn", aliases: ["ярн", "йарн"], category: "Tooling", priority: 1 },
  { canonical: "nvm", aliases: ["эн ви эм", "нвм"], category: "Tooling", priority: 1 },
  { canonical: "pip", aliases: [], category: "Tooling", priority: 1 },
  { canonical: "venv", aliases: ["вэнв", "ви энв", "венв"], category: "Tooling", priority: 1 },
  { canonical: "Homebrew", aliases: ["хоумбрю", "хомбрю", "хоум брю"], category: "Tooling", priority: 1 },
  { canonical: "brew", aliases: [], category: "Tooling", priority: 1 },

  // ===========================================================================
  // React & friends
  // ===========================================================================
  { canonical: "React", aliases: ["реакт", "риэкт", "реакте", "реакта"], category: "Frontend", priority: 4 },
  { canonical: "React Query", aliases: ["реакт квери", "react query", "реакт-квери", "реакт кьюери", "реакт квэри"], category: "Frontend", priority: 5 },
  { canonical: "TanStack Query", aliases: ["танстак квери", "тан стак квери", "tanstack query", "тэнстак квери"], category: "Frontend", priority: 5 },
  { canonical: "Redux Toolkit", aliases: ["редакс тулкит", "редукс тулкит", "redux toolkit"], category: "Frontend", priority: 2 },
  { canonical: "Redux", aliases: ["редакс", "редукс", "редаксе"], category: "Frontend", priority: 2 },
  { canonical: "RTK Query", aliases: ["эр ти кей квери", "ртк квери"], category: "Frontend", priority: 1 },
  { canonical: "Zustand", aliases: ["зустанд", "цустанд", "зустанде"], category: "Frontend", priority: 5 },
  { canonical: "MobX", aliases: ["мобикс", "моб икс"], category: "Frontend", priority: 0 },
  { canonical: "SWR", aliases: ["эс дабл ю эр", "свр"], category: "Frontend", priority: 0 },
  { canonical: "JSX", aliases: ["джей эс икс", "джсх", "джейэсикс"], category: "React", priority: 2 },
  { canonical: "TSX", aliases: ["ти эс икс", "тиэсикс"], category: "React", priority: 2 },
  { canonical: "useEffect", aliases: ["юз эффект", "use effect", "юзэффект", "юз-эффект", "юз эффекта", "юз эффекте", "юзэффекта", "юз ефект"], category: "React", priority: 5 },
  { canonical: "useState", aliases: ["юз стейт", "use state", "юзстейт", "юз стейта", "юз стейте"], category: "React", priority: 5 },
  { canonical: "useMemo", aliases: ["юз мемо", "use memo", "юзмемо"], category: "React", priority: 3 },
  { canonical: "useCallback", aliases: ["юз колбэк", "юз коллбэк", "use callback", "юз колбек", "юзколбэк"], category: "React", priority: 3 },
  { canonical: "useRef", aliases: ["юз реф", "use ref", "юзреф", "юз рефа"], category: "React", priority: 3 },
  { canonical: "useContext", aliases: ["юз контекст", "use context", "юзконтекст"], category: "React", priority: 3 },
  { canonical: "useReducer", aliases: ["юз редьюсер", "юз редюсер", "use reducer"], category: "React", priority: 2 },
  { canonical: "useLayoutEffect", aliases: ["юз лейаут эффект", "use layout effect", "юз лэйаут эффект"], category: "React", priority: 1 },
  { canonical: "useQuery", aliases: ["юз квери", "use query", "юзквери", "юз кьюери"], category: "React", priority: 4 },
  { canonical: "useMutation", aliases: ["юз мутейшн", "use mutation", "юз мутация", "юз мьютейшн"], category: "React", priority: 3 },
  { canonical: "useNavigate", aliases: ["юз навигейт", "use navigate"], category: "React", priority: 1 },
  { canonical: "useParams", aliases: ["юз парамс", "use params"], category: "React", priority: 1 },
  { canonical: "useForm", aliases: ["юз форм", "use form"], category: "React", priority: 1 },
  { canonical: "useTransition", aliases: ["юз транзишн", "use transition"], category: "React", priority: 0 },
  { canonical: "useSyncExternalStore", aliases: ["юз синк экстернал стор"], category: "React", priority: 0 },
  { canonical: "forwardRef", aliases: ["форвард реф", "forward ref", "форвардреф"], category: "React", priority: 1 },
  { canonical: "Suspense", aliases: ["саспенс", "саспенсе"], category: "React", priority: 1 },
  { canonical: "ErrorBoundary", aliases: ["эррор баундари", "error boundary", "эрор баундери"], category: "React", priority: 1 },
  { canonical: "props", aliases: ["пропсы", "пропсах", "пропсов", "пропсами", "пропса", "пропсу"], category: "React", priority: 3 },
  { canonical: "state", aliases: ["стейт"], category: "React", priority: 2 },
  { canonical: "hook", aliases: ["хук"], category: "React", priority: 1 },
  // No "компонент" → "component" entry on purpose: it is an ordinary Russian noun that
  // declines, so forcing the English form yields "вот этот component слишком большой".
  // The same reasoning keeps "мутация" and "инвалидировать" out — see the denylist.
  { canonical: "re-render", aliases: ["ререндер", "ре рендер", "ререндера", "ререндеры"], category: "React", priority: 2 },
  { canonical: "hydration", aliases: ["гидрация", "гидратация", "хайдрейшн"], category: "React", priority: 1 },
  { canonical: "virtual DOM", aliases: ["виртуал дом"], category: "React", priority: 0 },
  { canonical: "SSR", aliases: ["эс эс эр"], category: "Frontend", priority: 1 },
  { canonical: "SSG", aliases: ["эс эс джи"], category: "Frontend", priority: 0 },
  { canonical: "Next.js", aliases: ["некст джей эс", "некст жс", "нэкст джиэс", "next js", "некста"], category: "Frontend", priority: 3 },
  { canonical: "Vue", aliases: ["вью", "вю"], category: "Frontend", priority: 1 },
  { canonical: "Angular", aliases: ["ангуляр", "энгуляр", "ангуляре"], category: "Frontend", priority: 1 },
  { canonical: "Svelte", aliases: ["свелт", "свэлт", "свельт"], category: "Frontend", priority: 1 },
  { canonical: "Astro", aliases: [], category: "Frontend", priority: 0 },
  { canonical: "React Router", aliases: ["реакт роутер", "react router", "реакт-роутер"], category: "Frontend", priority: 2 },
  { canonical: "React Hook Form", aliases: ["реакт хук форм", "react hook form"], category: "Frontend", priority: 1 },
  { canonical: "Formik", aliases: ["формик", "формике"], category: "Frontend", priority: 1 },
  { canonical: "Yup", aliases: ["яп схема", "yup"], category: "Frontend", priority: 1 },
  { canonical: "Zod", aliases: ["зод", "зот", "зода", "зоде", "зодом"], category: "Tooling", priority: 5 },

  // ===========================================================================
  // UI kits & styling
  // ===========================================================================
  { canonical: "MUI", aliases: ["эм ю ай", "материал юай", "material ui"], category: "Frontend", priority: 2 },
  { canonical: "Ant Design", aliases: ["ант дизайн", "энт дизайн"], category: "Frontend", priority: 1 },
  { canonical: "Chakra UI", aliases: ["чакра юай", "чакра ю ай"], category: "Frontend", priority: 0 },
  { canonical: "shadcn/ui", aliases: ["шадсиэн", "шадцн", "шад си эн", "шадсиэн юай"], category: "Frontend", priority: 1 },
  { canonical: "Radix UI", aliases: ["радикс юай", "радикс ю ай"], category: "Frontend", priority: 0 },
  { canonical: "Tailwind", aliases: ["тейлвинд", "тэйлвинд", "тайлвинд", "тейлвинде"], category: "Frontend", priority: 4 },
  { canonical: "styled-components", aliases: ["стайлд компонентс", "стайл компонентс"], category: "Frontend", priority: 1 },
  { canonical: "Storybook", aliases: ["сторибук", "стори бук", "сторибуке"], category: "Frontend", priority: 1 },
  { canonical: "Framer Motion", aliases: ["фреймер моушн", "фрэймер моушен"], category: "Frontend", priority: 0 },
  { canonical: "Figma", aliases: ["фигма", "фигме", "фигмы", "фигму"], category: "Frontend", priority: 2 },

  // ===========================================================================
  // Build tooling
  // ===========================================================================
  { canonical: "Vite", aliases: ["вите", "вайти"], category: "Tooling", priority: 5 },
  { canonical: "Webpack", aliases: ["вебпак", "веб пак", "вебпаке"], category: "Tooling", priority: 2 },
  { canonical: "Rollup", aliases: ["роллап", "ролап"], category: "Tooling", priority: 1 },
  { canonical: "esbuild", aliases: ["эсбилд", "и эс билд"], category: "Tooling", priority: 1 },
  { canonical: "Babel", aliases: ["бабель", "бэйбл", "бабел"], category: "Tooling", priority: 1 },
  { canonical: "Turborepo", aliases: ["турборепо", "турбо репо"], category: "Tooling", priority: 1 },
  { canonical: "tsconfig", aliases: ["тэсконфиг", "ти эс конфиг", "тиэсконфиг"], category: "Tooling", priority: 2 },
  { canonical: "tsc", aliases: ["ти эс си", "тиэсси"], category: "Tooling", priority: 1 },
  { canonical: "ESLint", aliases: ["ислинт", "и эс линт", "эслинт", "эслинта", "эслинте"], category: "Tooling", priority: 5 },
  { canonical: "Prettier", aliases: ["преттиер", "приттиер", "претиер", "приттьер"], category: "Tooling", priority: 4 },
  { canonical: "Biome", aliases: [], category: "Tooling", priority: 0 },
  { canonical: "Makefile", aliases: ["мейкфайл", "мэйкфайл", "мейк файл"], category: "Tooling", priority: 3 },
  { canonical: "WebStorm", aliases: ["вебшторм", "веб шторм", "web storm", "вебшторме", "вебшторма"], category: "Tooling", priority: 5 },
  { canonical: "VS Code", aliases: ["вс код", "ви эс код", "вижуал студио код"], category: "Tooling", priority: 1 },

  // ===========================================================================
  // Testing
  // ===========================================================================
  { canonical: "Vitest", aliases: ["вайтест", "витест", "вайтесте"], category: "Testing", priority: 5 },
  { canonical: "Jest", aliases: ["джест", "джесте"], category: "Testing", priority: 2 },
  { canonical: "Playwright", aliases: ["плейрайт", "плэйрайт", "плей райт"], category: "Testing", priority: 2 },
  { canonical: "Cypress", aliases: ["сайпресс", "сайпрес", "кипресс"], category: "Testing", priority: 1 },
  { canonical: "Testing Library", aliases: ["тестинг лайбрари", "тестинг библиотека"], category: "Testing", priority: 1 },
  { canonical: "Puppeteer", aliases: ["паппетир", "папетир", "пупетир"], category: "Testing", priority: 0 },
  { canonical: "snapshot", aliases: ["снапшот", "снэпшот", "снапшоты"], category: "Testing", priority: 1 },
  { canonical: "coverage", aliases: ["каверидж", "ковередж", "коверейдж"], category: "Testing", priority: 1 },
  { canonical: "e2e", aliases: ["е два е"], category: "Testing", priority: 1 },
  { canonical: "TDD", aliases: ["ти ди ди", "тидиди"], category: "Testing", priority: 0 },
  { canonical: "flaky test", aliases: ["флейки тест", "флаки тест"], category: "Testing", priority: 0 },

  // ===========================================================================
  // Backend
  // ===========================================================================
  { canonical: "Express", aliases: [], category: "Backend", priority: 1 },
  { canonical: "Fastify", aliases: ["фастифай", "фастифае", "фаст ифай"], category: "Backend", priority: 5 },
  { canonical: "NestJS", aliases: ["нест джей эс", "нест жс", "нестжс"], category: "Backend", priority: 1 },
  { canonical: "Hono", aliases: [], category: "Backend", priority: 0 },
  { canonical: "Django", aliases: ["джанго", "джанге"], category: "Backend", priority: 1 },
  { canonical: "Flask", aliases: ["фласк"], category: "Backend", priority: 0 },
  { canonical: "FastAPI", aliases: ["фастапи", "фаст апи", "фастэпиай"], category: "Backend", priority: 2 },
  { canonical: "Laravel", aliases: ["ларавел", "ларавель", "ларавэль", "ларавеле"], category: "Backend", priority: 3 },
  { canonical: "Symfony", aliases: ["симфони"], category: "Backend", priority: 0 },
  { canonical: "Spring Boot", aliases: ["спринг бут", "спринг бот"], category: "Backend", priority: 0 },
  { canonical: "Prisma", aliases: ["присма", "призме"], category: "Backend", priority: 2 },
  { canonical: "Drizzle", aliases: ["дриззл", "дризл"], category: "Backend", priority: 1 },
  { canonical: "TypeORM", aliases: ["тайп орм", "тайпорм"], category: "Backend", priority: 1 },
  { canonical: "Sequelize", aliases: ["секвелайз", "сиквелайз"], category: "Backend", priority: 0 },
  { canonical: "PostgreSQL", aliases: ["постгрес", "постгрескл", "постгре", "постгресе", "постгреса"], category: "Backend", priority: 4 },
  { canonical: "MySQL", aliases: ["май эс кью эль", "майсиквел", "майскуль"], category: "Backend", priority: 1 },
  { canonical: "SQLite", aliases: ["скюлайт", "эс кью лайт", "сиквелайт", "эскьюлайт"], category: "Backend", priority: 5 },
  { canonical: "MongoDB", aliases: ["монго", "монгодб", "монго ди би"], category: "Backend", priority: 1 },
  { canonical: "Redis", aliases: ["редис", "рэдис", "редисе"], category: "Backend", priority: 2 },
  { canonical: "Elasticsearch", aliases: ["эластик серч", "эластиксерч", "эластик"], category: "Backend", priority: 1 },
  { canonical: "ClickHouse", aliases: ["кликхаус", "клик хаус"], category: "Backend", priority: 0 },
  { canonical: "Kafka", aliases: ["кафка", "кафке", "кафку"], category: "Backend", priority: 1 },
  { canonical: "RabbitMQ", aliases: ["рэббит эм кью", "раббит эм кью"], category: "Backend", priority: 0 },
  { canonical: "Nginx", aliases: ["энджинкс", "нгинкс", "энжиникс"], category: "DevOps", priority: 1 },
  { canonical: "gRPC", aliases: ["джи ар пи си"], category: "Backend", priority: 1 },
  { canonical: "tRPC", aliases: ["ти ар пи си"], category: "Backend", priority: 0 },
  { canonical: "WebSocket", aliases: ["вебсокет", "веб сокет", "вебсокеты", "вебсокете"], category: "Networking", priority: 2 },
  { canonical: "Socket.IO", aliases: ["сокет ай о", "сокет ио"], category: "Networking", priority: 0 },
  { canonical: "Server-Sent Events", aliases: ["сервер сент ивентс"], category: "Networking", priority: 1 },
  { canonical: "API", aliases: ["эй пи ай", "апишка", "апишке", "апишку"], category: "General", priority: 3 },
  { canonical: "REST API", aliases: ["рест апи", "рест-апи", "рэст апи"], category: "Backend", priority: 2 },
  { canonical: "endpoint", aliases: ["эндпоинт", "энд поинт", "эндпойнт", "эндпоинты", "эндпоинта", "эндпоинте"], category: "Backend", priority: 3 },
  { canonical: "middleware", aliases: ["миддлвар", "мидлвар", "мидлвара", "миддлвэр", "мидлварь"], category: "Backend", priority: 2 },
  { canonical: "webhook", aliases: ["вебхук", "веб хук", "вебхуки", "вебхука"], category: "Backend", priority: 2 },
  { canonical: "JWT", aliases: ["джей дабл ю ти", "джот токен", "жвт"], category: "Backend", priority: 1 },
  { canonical: "OAuth", aliases: ["оаус", "о аус", "оауф"], category: "Backend", priority: 1 },
  { canonical: "CORS", aliases: ["корс", "корсы", "корса"], category: "Networking", priority: 2 },
  { canonical: "CSRF", aliases: ["си эс эр эф", "цсрф"], category: "Security", priority: 0 },
  { canonical: "XSS", aliases: ["икс эс эс", "иксэсэс"], category: "Security", priority: 0 },
  { canonical: "SQL injection", aliases: [], category: "Security", priority: 0 },
  { canonical: "CRUD", aliases: ["круд"], category: "Backend", priority: 1 },
  { canonical: "ORM", aliases: ["орм", "о эр эм"], category: "Backend", priority: 1 },

  // ===========================================================================
  // Networking & HTTP
  // ===========================================================================
  { canonical: "fetch", aliases: ["фетч", "фечь", "фэтч", "фетча", "фетче"], category: "Networking", priority: 3 },
  { canonical: "Axios", aliases: ["аксиос", "аксиус", "аксиосе"], category: "Networking", priority: 3 },
  { canonical: "AbortController", aliases: ["аборт контроллер", "abort controller", "эборт контроллер", "аборт контроллера", "аборт-контроллер"], category: "Networking", priority: 5 },
  { canonical: "AbortSignal", aliases: ["аборт сигнал", "abort signal"], category: "Networking", priority: 1 },
  { canonical: "payload", aliases: ["пейлоад", "пэйлоад", "пейлод"], category: "Networking", priority: 1 },
  { canonical: "header", aliases: ["хедер", "хэдер", "хедеры", "хэдеры", "хедера"], category: "Networking", priority: 2 },
  { canonical: "query param", aliases: ["квери парам", "квери парамс", "кьюери парам"], category: "Networking", priority: 1 },
  { canonical: "status code", aliases: ["статус код", "статус коды"], category: "Networking", priority: 1 },
  { canonical: "timeout", aliases: ["таймаут", "тайм аут", "таймауты", "таймаута", "таймауте"], category: "Networking", priority: 2 },
  { canonical: "retry", aliases: ["ретрай", "ретраи", "ретраев"], category: "Networking", priority: 2 },
  { canonical: "polling", aliases: ["поллинг", "полинг"], category: "Networking", priority: 1 },
  { canonical: "rate limit", aliases: ["рейт лимит", "рейт-лимит", "рэйт лимит"], category: "Networking", priority: 1 },
  { canonical: "debounce", aliases: ["дебаунс", "дебоунс", "дибаунс"], category: "Frontend", priority: 2 },
  { canonical: "throttle", aliases: ["троттл", "тротлинг", "троттлинг"], category: "Frontend", priority: 1 },
  { canonical: "idempotent", aliases: [], category: "Concepts", priority: 0 },
  { canonical: "pagination", aliases: [], category: "Concepts", priority: 1 },

  // ===========================================================================
  // Git
  // ===========================================================================
  { canonical: "Git", aliases: ["гит"], category: "Git", priority: 3 },
  { canonical: "GitHub", aliases: ["гитхаб", "гит хаб", "гит-хаб", "гитхабе", "гитхаба"], category: "Git", priority: 4 },
  { canonical: "GitLab", aliases: ["гитлаб", "гит лаб", "гитлабе"], category: "Git", priority: 1 },
  { canonical: "pull request", aliases: ["пулл реквест", "пул реквест", "пулреквест", "пулл-реквест", "пулл риквест"], category: "Git", priority: 3 },
  { canonical: "merge request", aliases: ["мердж реквест", "мерж реквест"], category: "Git", priority: 1 },
  { canonical: "rebase", aliases: ["ребейз", "рибейз", "ребейзе", "ребейс"], category: "Git", priority: 2 },
  { canonical: "cherry-pick", aliases: ["черри пик", "чери пик", "черри-пик"], category: "Git", priority: 1 },
  { canonical: "stash", aliases: ["сташ", "стэш", "сташе"], category: "Git", priority: 1 },
  { canonical: "checkout", aliases: ["чекаут", "чек аут"], category: "Git", priority: 2 },
  { canonical: "force push", aliases: ["форс пуш", "форспуш"], category: "Git", priority: 1 },
  { canonical: "merge conflict", aliases: ["мердж конфликт", "мерж конфликт", "мерж-конфликт"], category: "Git", priority: 1 },
  { canonical: "squash", aliases: ["сквош", "скваш"], category: "Git", priority: 1 },
  { canonical: "submodule", aliases: ["сабмодуль", "саб модуль", "сабмодули"], category: "Git", priority: 0 },
  { canonical: "worktree", aliases: ["вёрктри", "ворк три", "ворктри"], category: "Git", priority: 1 },
  { canonical: ".gitignore", aliases: ["гитигнор", "гит игнор", "гитигноре"], category: "Git", priority: 2 },
  { canonical: "upstream", aliases: ["апстрим", "ап стрим", "апстриме"], category: "Git", priority: 1 },
  { canonical: "origin", aliases: ["ориджин", "ориджине", "оригин"], category: "Git", priority: 1 },
  { canonical: "changelog", aliases: ["ченджлог", "чейнджлог", "ченж лог"], category: "Git", priority: 1 },
  { canonical: "semver", aliases: ["семвер", "сэмвер", "семантик версионинг"], category: "Git", priority: 0 },
  { canonical: "monorepo", aliases: ["монорепо", "моно репо", "монорепе"], category: "Tooling", priority: 2 },

  // ===========================================================================
  // Shell & CLI
  // ===========================================================================
  { canonical: "grep", aliases: ["греп", "грэп"], category: "Shell", priority: 2 },
  { canonical: "ripgrep", aliases: ["рипгреп", "рип греп"], category: "Shell", priority: 1 },
  { canonical: "sed", aliases: [], category: "Shell", priority: 1 },
  { canonical: "curl", aliases: ["курл", "кёрл"], category: "Shell", priority: 2 },
  { canonical: "ssh", aliases: ["эс эс эйч", "ссш"], category: "Shell", priority: 1 },
  { canonical: "sudo", aliases: ["судо", "сюдо"], category: "Shell", priority: 1 },
  { canonical: "chmod", aliases: ["чмод", "ч мод", "чейндж мод"], category: "Shell", priority: 1 },
  { canonical: "tmux", aliases: ["тимукс", "ти макс", "тмукс"], category: "Shell", priority: 0 },
  { canonical: "jq", aliases: ["джей кью", "джейкью"], category: "Shell", priority: 1 },
  { canonical: "stdout", aliases: ["стдаут", "эс ти ди аут"], category: "Shell", priority: 1 },
  { canonical: "stderr", aliases: ["стдэрр", "эс ти ди эрор"], category: "Shell", priority: 1 },
  { canonical: "stdin", aliases: ["стдин", "эс ти ди ин"], category: "Shell", priority: 1 },
  { canonical: "exit code", aliases: ["экзит код", "эксит код"], category: "Shell", priority: 1 },
  { canonical: "PATH", aliases: [], category: "Shell", priority: 0 },
  { canonical: ".env", aliases: ["дотэнв", "точка энв", "енв файл", "энв файл"], category: "Tooling", priority: 2 },

  // ===========================================================================
  // DevOps & cloud
  // ===========================================================================
  { canonical: "Docker", aliases: ["докер", "доккер", "докере", "докера"], category: "DevOps", priority: 3 },
  { canonical: "Docker Compose", aliases: ["докер компоуз", "докер компос", "докер-компоуз"], category: "DevOps", priority: 1 },
  { canonical: "Kubernetes", aliases: ["кубернетес", "кубернетис", "кубер", "кубернетесе"], category: "DevOps", priority: 1 },
  { canonical: "Terraform", aliases: ["терраформ", "тераформ"], category: "DevOps", priority: 0 },
  { canonical: "CI/CD", aliases: ["си ай си ди", "сиайсиди", "ци цд"], category: "DevOps", priority: 2 },
  { canonical: "GitHub Actions", aliases: ["гитхаб экшенс", "гитхаб экшнс", "гит хаб экшенс"], category: "DevOps", priority: 2 },
  { canonical: "AWS", aliases: ["эй дабл ю эс", "авс"], category: "DevOps", priority: 1 },
  { canonical: "Vercel", aliases: ["версель", "верцель", "версел"], category: "DevOps", priority: 1 },
  { canonical: "Netlify", aliases: ["нетлифай", "нэтлифай"], category: "DevOps", priority: 0 },
  { canonical: "Cloudflare", aliases: ["клаудфлейр", "клауд флейр", "клаудфлер"], category: "DevOps", priority: 1 },
  { canonical: "Supabase", aliases: ["супабейс", "супабэйс", "супа бейс"], category: "DevOps", priority: 1 },
  { canonical: "Firebase", aliases: ["файрбейс", "фаербейс", "файербейс"], category: "DevOps", priority: 1 },
  { canonical: "Sentry", aliases: ["сентри", "сэнтри"], category: "DevOps", priority: 1 },
  { canonical: "Grafana", aliases: ["графана", "графане"], category: "DevOps", priority: 0 },
  { canonical: "systemd", aliases: ["системди", "систем ди"], category: "DevOps", priority: 0 },

  // ===========================================================================
  // Apple platform — this project ships a Swift agent, so it comes up daily.
  // ===========================================================================
  { canonical: "SwiftUI", aliases: ["свифт юай", "свифтюай", "свифт ю ай"], category: "Apple", priority: 5 },
  { canonical: "Xcode", aliases: ["икскод", "икс код", "эксод", "экскод"], category: "Apple", priority: 5 },
  { canonical: "AppKit", aliases: ["апкит", "эпкит", "ап кит"], category: "Apple", priority: 2 },
  { canonical: "UIKit", aliases: ["юай кит", "юайкит"], category: "Apple", priority: 1 },
  { canonical: "Objective-C", aliases: ["обжектив си", "обжектив-си"], category: "Apple", priority: 0 },
  { canonical: "Accessibility API", aliases: ["аксессибилити апи", "аксесибилити апи"], category: "Apple", priority: 1 },
  { canonical: "Info.plist", aliases: ["инфо плист", "инфо пи лист"], category: "Apple", priority: 1 },
  { canonical: "code signing", aliases: ["код сайнинг", "кодсайнинг"], category: "Apple", priority: 1 },
  { canonical: "notarization", aliases: [], category: "Apple", priority: 0 },
  { canonical: "launchd", aliases: ["лончди", "ланчди", "лаунчди"], category: "Apple", priority: 1 },
  { canonical: "LaunchAgent", aliases: ["лонч агент", "ланч агент", "лаунч агент"], category: "Apple", priority: 1 },
  { canonical: "TCC", aliases: ["ти си си", "тисиси"], category: "Apple", priority: 1 },
  { canonical: "bundle ID", aliases: ["бандл айди", "бандл ид", "бандл ай ди"], category: "Apple", priority: 1 },
  { canonical: "entitlements", aliases: ["энтайтлментс", "энтайтлменты"], category: "Apple", priority: 0 },
  { canonical: "Swift Package Manager", aliases: ["свифт пакет менеджер", "спм"], category: "Apple", priority: 0 },
  { canonical: "macOS", aliases: ["макос", "мак ос", "макоси"], category: "Apple", priority: 2 },
  { canonical: "NSPasteboard", aliases: ["эн эс пейстборд", "пейстборд"], category: "Apple", priority: 0 },
  { canonical: "CGEvent", aliases: ["си джи ивент", "сиджи ивент"], category: "Apple", priority: 0 },

  // ===========================================================================
  // Language & engineering concepts
  // ===========================================================================
  { canonical: "frontend", aliases: ["фронтенд", "фронт энд", "фронт-энд", "фронтенде", "фронтенда"], category: "General", priority: 3 },
  { canonical: "backend", aliases: ["бэкенд", "бекенд", "бэк энд", "бэк-энд", "бэкенде", "бэкенда"], category: "General", priority: 3 },
  { canonical: "fullstack", aliases: ["фулстек", "фулл стек", "фуллстэк"], category: "General", priority: 0 },
  { canonical: "async/await", aliases: ["асинк эвейт", "эсинк эвейт", "асинк авейт"], category: "Concepts", priority: 1 },
  { canonical: "Promise", aliases: ["промис", "промисы", "промиса", "промисе"], category: "Concepts", priority: 2 },
  { canonical: "callback", aliases: ["колбэк", "коллбэк", "колбек", "колбэки", "колбэка"], category: "Concepts", priority: 2 },
  { canonical: "closure", aliases: ["клоужер", "клозура", "клоужер функции"], category: "Concepts", priority: 0 },
  { canonical: "event loop", aliases: ["ивент луп", "эвент луп"], category: "Concepts", priority: 1 },
  { canonical: "race condition", aliases: ["рейс кондишн", "рейс кондишен"], category: "Concepts", priority: 1 },
  { canonical: "memory leak", aliases: ["мемори лик"], category: "Concepts", priority: 1 },
  { canonical: "immutable", aliases: ["имьютабл"], category: "Concepts", priority: 1 },
  { canonical: "side effect", aliases: ["сайд эффект", "сайд-эффект", "сайд эффекты"], category: "Concepts", priority: 2 },
  { canonical: "dependency injection", aliases: ["депенденси инжекшн"], category: "Concepts", priority: 0 },
  { canonical: "singleton", aliases: ["синглтон", "синглетон"], category: "Concepts", priority: 1 },
  { canonical: "boilerplate", aliases: ["бойлерплейт", "бойлер плейт"], category: "Concepts", priority: 1 },
  { canonical: "edge case", aliases: ["эдж кейс", "эдж кейсы", "эдж-кейс"], category: "Concepts", priority: 2 },
  { canonical: "breaking change", aliases: ["брейкинг чендж", "брейкинг ченж"], category: "Concepts", priority: 1 },
  { canonical: "feature flag", aliases: ["фича флаг", "фичер флаг", "фиче флаг"], category: "Concepts", priority: 1 },
  { canonical: "technical debt", aliases: ["техникал дебт"], category: "Concepts", priority: 1 },
  { canonical: "code review", aliases: ["код ревью", "кодревью", "код-ревью"], category: "Concepts", priority: 2 },
  { canonical: "deprecated", aliases: ["депрекейтед", "депрекатед", "депрекейтнутый"], category: "Concepts", priority: 1 },
  { canonical: "lazy loading", aliases: ["лейзи лоадинг", "лэйзи лоадинг"], category: "Frontend", priority: 1 },
  { canonical: "tree shaking", aliases: ["три шейкинг", "тришейкинг"], category: "Frontend", priority: 0 },
  { canonical: "code splitting", aliases: ["код сплиттинг", "код сплитинг"], category: "Frontend", priority: 0 },
  { canonical: "hot reload", aliases: ["хот релоад", "хотрелоад"], category: "Frontend", priority: 1 },
  { canonical: "source map", aliases: ["сорс мап", "сорс мапы", "сурс мап"], category: "Tooling", priority: 1 },
  { canonical: "type guard", aliases: ["тайп гард", "тайпгард"], category: "Language", priority: 1 },
  { canonical: "generic", aliases: ["дженерик", "дженерики", "дженерика", "дженериком"], category: "Language", priority: 2 },
  { canonical: "enum", aliases: ["энум", "инум", "энума", "энуме"], category: "Language", priority: 2 },
  { canonical: "union type", aliases: ["юнион тайп", "юнион тип"], category: "Language", priority: 1 },
  { canonical: "optional chaining", aliases: ["опшнал чейнинг", "опциональный чейнинг"], category: "Language", priority: 0 },
  { canonical: "destructuring", aliases: ["деструктуринг"], category: "Language", priority: 1 },
  { canonical: "spread", aliases: ["спред оператор", "спрэд оператор"], category: "Language", priority: 1 },
  { canonical: "linter", aliases: [], category: "Tooling", priority: 1 },
  { canonical: "stack trace", aliases: ["стек трейс", "стэк трейс", "стектрейс"], category: "Concepts", priority: 2 },
  { canonical: "breakpoint", aliases: ["брейкпоинт", "брейк поинт", "брейкпоинты"], category: "Concepts", priority: 1 },
  { canonical: "cleanup", aliases: ["клинап", "клин ап", "клинапе", "клинапа"], category: "React", priority: 3 },
  { canonical: "invalidate", aliases: ["инвалидейт"], category: "Frontend", priority: 1 },
  { canonical: "mutation", aliases: ["мутейшн"], category: "Frontend", priority: 1 },
  { canonical: "refetch", aliases: ["рефетч", "ре фетч", "рефэтч"], category: "Frontend", priority: 2 },
  { canonical: "prefetch", aliases: ["префетч", "пре фетч"], category: "Frontend", priority: 1 },

  // ===========================================================================
  // Naming conventions — dictated constantly when asking for code, and Whisper
  // has no idea these are single identifiers.
  // ===========================================================================
  { canonical: "camelCase", aliases: ["кэмел кейс", "камел кейс", "кемел кейс", "кэмелкейс"], category: "Concepts", priority: 3 },
  { canonical: "PascalCase", aliases: ["паскаль кейс", "паскал кейс", "паскалькейс"], category: "Concepts", priority: 3 },
  { canonical: "kebab-case", aliases: ["кебаб кейс", "кебаб-кейс", "кабаб кейс"], category: "Concepts", priority: 3 },
  { canonical: "snake_case", aliases: ["снейк кейс", "снек кейс", "снейккейс"], category: "Concepts", priority: 3 },
  { canonical: "SCREAMING_SNAKE_CASE", aliases: ["скриминг снейк кейс", "капсом снейк кейс"], category: "Concepts", priority: 0 },

  // ===========================================================================
  // Identifiers that come up in this codebase and in everyday examples
  // ===========================================================================
  { canonical: "userData", aliases: ["юзер дата", "user data", "юзердата", "юзер даты"], category: "Identifiers", priority: 3 },
  { canonical: "userId", aliases: ["юзер айди", "user id", "юзер ид", "юзерайди"], category: "Identifiers", priority: 3 },
  { canonical: "UserProfile", aliases: ["юзер профайл", "user profile", "юзер профиль"], category: "Identifiers", priority: 2 },
  { canonical: "isLoading", aliases: ["из лоадинг", "ис лоадинг"], category: "Identifiers", priority: 1 },
  { canonical: "onChange", aliases: ["он чендж", "он ченж", "онченж"], category: "Identifiers", priority: 1 },
  { canonical: "onClick", aliases: ["он клик", "онклик"], category: "Identifiers", priority: 1 },
  { canonical: "onSubmit", aliases: ["он сабмит", "онсабмит"], category: "Identifiers", priority: 1 },
  { canonical: "handleSubmit", aliases: ["хендл сабмит", "хэндл сабмит"], category: "Identifiers", priority: 1 },
  { canonical: "queryKey", aliases: ["квери кей", "кьюери кей", "квери ключ"], category: "Identifiers", priority: 2 },
  { canonical: "queryClient", aliases: ["квери клиент", "кьюери клиент"], category: "Identifiers", priority: 2 },
  { canonical: "package.json", aliases: ["пэкедж джейсон", "пакедж джейсон", "пакет джейсон", "пэкидж джсон"], category: "Identifiers", priority: 3 },
  { canonical: "tsconfig.json", aliases: ["тэсконфиг джейсон", "ти эс конфиг джейсон"], category: "Identifiers", priority: 1 },
  { canonical: "README", aliases: ["ридми", "рид ми", "ридмишка"], category: "Identifiers", priority: 2 },
  { canonical: "TODO", aliases: ["тудушка", "ту ду", "тудушки"], category: "Identifiers", priority: 1 },

  // ===========================================================================
  // Personal projects & this app
  // ===========================================================================
  { canonical: "LocalVoiceFlow", aliases: ["локал войс флоу", "локал воис флоу", "локалвойсфлоу"], category: "Projects", priority: 2 },
  { canonical: "Wispr Flow", aliases: ["виспер флоу", "виспр флоу", "виспа флоу"], category: "Projects", priority: 1 },
  { canonical: "mac-agent", aliases: ["мак агент", "мак-агент", "макагент"], category: "Projects", priority: 2 },
  { canonical: "stt-worker", aliases: ["эс ти ти воркер", "стт воркер"], category: "Projects", priority: 1 },
  { canonical: "HUD", aliases: [], category: "Projects", priority: 1 },
  { canonical: "PayAtTable", aliases: ["пей эт тейбл", "пэй эт тэйбл", "pay at table"], category: "Projects", priority: 2 },
  { canonical: "YapYap", aliases: ["яп яп", "яп-яп", "yap yap"], category: "Projects", priority: 2 },
];

/**
 * The seed as the database consumes it: every optional field resolved.
 *
 * `language` defaults to `mixed` because that is what every seeded term is — a Russian
 * sentence carrying an English identifier — and repeating it on three hundred rows only
 * hid the rows that differ.
 */
export const SEED_DICTIONARY: readonly DictionaryTermInput[] = RAW_SEED.map((term) => ({
  canonical: term.canonical,
  aliases: term.aliases ?? [],
  category: term.category ?? null,
  language: term.language ?? "mixed",
  notes: term.notes ?? null,
  enabled: true,
  priority: term.priority ?? 0,
}));
