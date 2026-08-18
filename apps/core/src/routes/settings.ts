import { z } from "zod";
import {
  AppProfileSchema,
  ModelIdSchema,
  SettingsPatchSchema,
  knownEffortsFor,
  type ProviderId,
} from "@lvf/shared";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { buildClaudeArgs } from "../providers/claude.js";
import { buildCodexArgs } from "../providers/codex.js";

const PresetSchema = z.object({
  provider: z.enum(["claude-cli", "openai-codex-cli"]),
  model: ModelIdSchema,
  effort: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(120),
});

export function registerSettingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/settings", async (_request, reply) => {
    return reply.send(ctx.db.getSettings());
  });

  app.patch("/api/settings", async (request, reply) => {
    const parsed = SettingsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }

    const before = ctx.db.getSettings();
    const after = ctx.db.patchSettings(parsed.data);

    ctx.logger.setLevel(after.privacy.logLevel);

    // Only a model or interpreter change forces the worker to reload; everything else
    // takes effect on the next dictation with no restart.
    if (
      before.stt.model !== after.stt.model ||
      before.stt.warmUpOnStart !== after.stt.warmUpOnStart
    ) {
      ctx.onSttSettingsChanged(after);
    }

    // The local-LLM worker manager decides for itself whether anything must start,
    // stop, reload or re-warm — its operations are idempotent, so any correction
    // change may notify it.
    if (JSON.stringify(before.correction) !== JSON.stringify(after.correction)) {
      ctx.onCorrectionSettingsChanged(after);
    }

    ctx.events.publish({ type: "settings-changed", at: new Date().toISOString() });
    return reply.send(after);
  });

  app.get("/api/settings/prompt", async (_request, reply) => {
    const custom = ctx.db.getSettings().correction.customSystemPrompt;
    return reply.send({
      systemPrompt: ctx.loadSystemPrompt(),
      defaultPrompt: ctx.defaultSystemPrompt(),
      isCustom: custom.trim().length > 0,
    });
  });

  app.post("/api/settings/reset-prompt", async (_request, reply) => {
    const after = ctx.db.patchSettings({ correction: { customSystemPrompt: "" } });
    // The local worker caches the system prompt; give it a chance to re-warm.
    ctx.onCorrectionSettingsChanged(after);
    ctx.events.publish({ type: "settings-changed", at: new Date().toISOString() });
    return reply.send({ systemPrompt: ctx.defaultSystemPrompt() });
  });

  app.get("/api/settings/efforts", async (_request, reply) => {
    return reply.send({
      "claude-cli": knownEffortsFor("claude-cli"),
      "openai-codex-cli": knownEffortsFor("openai-codex-cli"),
      "local-mlx": knownEffortsFor("local-mlx"),
    });
  });

  /**
   * The exact argv the core would run, with no user text and no secrets.
   * Rendering it in the UI is how the user verifies the subscription-only claims.
   */
  app.get("/api/settings/command-preview", async (request, reply) => {
    const query = request.query as { provider?: string; model?: string; effort?: string };
    const settings = ctx.db.getSettings();
    const provider = (query.provider ?? settings.correction.provider) as ProviderId;
    const model = query.model ?? settings.correction.model;
    const effort = query.effort ?? settings.correction.effort;

    const removedEnv = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
    ];

    if (provider === "local-mlx") {
      return reply.send({
        provider,
        command: "<venv python>",
        args: ["-m", "lvf_stt", "--role", "llm", "--model", model],
        stdin: "<JSON Lines protocol: system prompt + JSON payload: app context, glossary, dictation>",
        removedEnv: [],
        note: "Runs entirely on this Mac inside a persistent worker process; the dictated text never leaves the machine.",
      });
    }

    if (provider === "openai-codex-cli") {
      return reply.send({
        provider,
        command: "codex",
        args: buildCodexArgs({
          model,
          effort,
          workDir: "<empty app work dir>",
          schemaFile: "<temp>/schema.json",
          outputFile: "<temp>/output.json",
        }),
        stdin: "<system prompt> + <JSON payload: app context, glossary, dictation>",
        removedEnv,
        note: "The dictated text is written to stdin, never passed as an argument and never through a shell.",
      });
    }

    return reply.send({
      provider,
      command: "claude",
      args: buildClaudeArgs({
        model,
        effort,
        systemPromptFile: "<temp>/system-prompt.md",
      }),
      stdin: "<JSON payload: app context, glossary, dictation>",
      extraEnv: settings.correction.disableThinking
        ? { MAX_THINKING_TOKENS: "0" }
        : {},
      removedEnv,
      note: "The dictated text is written to stdin, never passed as an argument and never through a shell.",
    });
  });

  // --- App profiles --------------------------------------------------------

  app.get("/api/app-profiles", async (_request, reply) => {
    return reply.send({ items: ctx.db.listAppProfiles() });
  });

  app.put("/api/app-profiles", async (request, reply) => {
    const parsed = AppProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    return reply.send(ctx.db.upsertAppProfile(parsed.data));
  });

  app.delete<{ Params: { bundleId: string } }>(
    "/api/app-profiles/:bundleId",
    async (request, reply) => {
      const deleted = ctx.db.deleteAppProfile(decodeURIComponent(request.params.bundleId));
      if (!deleted) {
        return reply.code(404).send({ error: { code: "not_found", message: "no such rule" } });
      }
      return reply.send({ deleted: true });
    },
  );

  // --- Provider presets ----------------------------------------------------

  app.get("/api/provider-presets", async (_request, reply) => {
    return reply.send({ items: ctx.db.listProviderPresets() });
  });

  app.post("/api/provider-presets", async (request, reply) => {
    const parsed = PresetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: parsed.error.message } });
    }
    return reply.code(201).send(ctx.db.upsertProviderPreset(parsed.data));
  });

  app.delete<{ Params: { id: string } }>("/api/provider-presets/:id", async (request, reply) => {
    const deleted = ctx.db.deleteProviderPreset(request.params.id);
    if (!deleted) {
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "no such custom preset" } });
    }
    return reply.send({ deleted: true });
  });
}
