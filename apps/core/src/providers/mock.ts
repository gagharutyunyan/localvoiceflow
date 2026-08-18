import {
  applyDeterministicReplacements,
  type CorrectionInput,
  type CorrectionResult,
  type DictionaryTerm,
  type ProviderConfig,
  type ProviderHealth,
  type SttHealth,
  type SttInput,
  type SttProvider,
  type SttResult,
  type TextCorrectionProvider,
} from "@lvf/shared";

/**
 * Deterministic stand-ins used by the integration tests and by `LVF_MOCK=1`.
 *
 * They exist so the end-to-end pipeline can be exercised without a GPU, without network
 * access and without spending subscription quota. They are never selected implicitly in
 * a normal run — the settings value has to say "mock".
 */

export interface MockSttOptions {
  transcript?: string;
  detectedLanguage?: string;
  audioDurationMs?: number;
  latencyMs?: number;
  noSpeech?: boolean;
  failWith?: Error;
}

export class MockSttProvider implements SttProvider {
  #options: MockSttOptions;
  calls: SttInput[] = [];

  constructor(options: MockSttOptions = {}) {
    this.#options = options;
  }

  configure(options: MockSttOptions): void {
    this.#options = { ...this.#options, ...options };
  }

  async health(): Promise<SttHealth> {
    return {
      ready: true,
      state: "ready",
      backend: "mock",
      model: "mock-whisper",
      device: "cpu",
      warmedUp: true,
      loadMs: 0,
      restarts: 0,
    };
  }

  async transcribe(input: SttInput): Promise<SttResult> {
    this.calls.push(input);
    if (this.#options.failWith) throw this.#options.failWith;

    const latency = this.#options.latencyMs ?? 5;
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));

    const noSpeech = this.#options.noSpeech ?? false;
    return {
      rawTranscript: noSpeech ? "" : (this.#options.transcript ?? "тестовая расшифровка"),
      detectedLanguage: this.#options.detectedLanguage ?? "ru",
      audioDurationMs: this.#options.audioDurationMs ?? 1500,
      transcriptionMs: latency,
      model: "mock-whisper",
      noSpeech,
      warnings: [],
    };
  }
}

export interface MockCorrectionOptions {
  /** Overrides the default behaviour entirely. */
  transform?: (input: CorrectionInput) => string;
  latencyMs?: number;
  failWith?: Error;
  authenticated?: boolean;
  terms?: readonly DictionaryTerm[];
}

/**
 * Applies glossary canonicalisation plus trivial punctuation so tests can assert a
 * meaningful transformation without depending on a real model's wording.
 */
export class MockCorrectionProvider implements TextCorrectionProvider {
  readonly id = "mock" as const;

  #options: MockCorrectionOptions;
  calls: Array<{ input: CorrectionInput; config: ProviderConfig }> = [];

  constructor(options: MockCorrectionOptions = {}) {
    this.#options = options;
  }

  configure(options: MockCorrectionOptions): void {
    this.#options = { ...this.#options, ...options };
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      available: true,
      authenticated: this.#options.authenticated ?? true,
      apiKeyEnvPresent: [],
      missingFlags: [],
      cliPath: "(mock)",
      version: "mock",
      authDetail: "mock provider",
    };
  }

  async correct(
    input: CorrectionInput,
    config: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<CorrectionResult> {
    this.calls.push({ input, config });

    const latency = this.#options.latencyMs ?? 5;
    if (latency > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, latency);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
    }

    if (this.#options.failWith) throw this.#options.failWith;

    const finalText = this.#options.transform
      ? this.#options.transform(input)
      : mockEdit(input, this.#options.terms ?? []);

    return {
      finalText,
      provider: this.id,
      model: config.model,
      effort: config.effort,
      latencyMs: latency,
      metadata: { mock: true },
      warnings: [],
    };
  }
}

function mockEdit(input: CorrectionInput, terms: readonly DictionaryTerm[]): string {
  const synthetic: DictionaryTerm[] = input.glossary.map((entry, index) => ({
    id: `mock-${index}`,
    canonical: entry.canonical,
    aliases: entry.aliases,
    enabled: true,
    priority: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  }));

  const { text } = applyDeterministicReplacements(input.rawTranscript, [...synthetic, ...terms]);
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";

  const capitalized = trimmed.charAt(0).toLocaleUpperCase("ru-RU") + trimmed.slice(1);
  return /[.!?…]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
