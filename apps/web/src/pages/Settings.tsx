import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  FormattingProfileSchema,
  SttLanguageSchema,
  TargetChangedBehaviorSchema,
} from "@lvf/shared";
import type { AppProfile, FormattingProfile, Settings as SettingsData, SettingsPatch } from "@lvf/shared";
import { api, errorMessage, isApiError } from "../api/client";
import { useAsync } from "../api/hooks";
import type { CommandPreview, DiagnosticsReport, TestProviderResult } from "../api/types";
import { Card, FieldRow } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyButton } from "../components/CopyButton";
import { Spinner } from "../components/Spinner";
import { StatusPill } from "../components/StatusPill";
import { Labeled, Toolbar } from "../components/Toolbar";
import { useToast } from "../components/Toast";
import { EM_DASH, downloadText, formatDateTime, formatMs, stamp } from "../lib/format";
import {
  PROVIDER_LABELS,
  buildCommandPreview,
  defaultEffortFor,
  defaultModelFor,
  effortsFor,
  providerLabel,
} from "../lib/providers";

const PRIVACY_LOCAL_AUDIO = "Audio is processed locally.";
const PRIVACY_LLM_SCOPE =
  "Only the recognized text and selected glossary terms are sent to the chosen LLM provider.";

const LAST_CHECK_PREFIX = "lvf.provider-check.";

/**
 * Quick presets only touch latency-vs-quality knobs; the model id is left alone so a
 * preset can never silently switch the user onto a model their subscription lacks.
 */
const QUICK_PRESETS = {
  balanced: { effort: "low", disableThinking: true, timeoutMs: 30_000 },
  quality: { effort: "high", disableThinking: false, timeoutMs: 60_000 },
} as const;

type QuickPresetName = keyof typeof QUICK_PRESETS | "custom";

function detectQuickPreset(correction: SettingsData["correction"]): QuickPresetName {
  for (const [name, preset] of Object.entries(QUICK_PRESETS)) {
    if (
      correction.effort === preset.effort &&
      correction.disableThinking === preset.disableThinking &&
      correction.timeoutMs === preset.timeoutMs
    ) {
      return name as QuickPresetName;
    }
  }
  return "custom";
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {hint && <span className="labeled-hint">{hint}</span>}
      </span>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}) {
  // The text being typed is buffered locally: a cleared field would otherwise commit
  // Number("") === 0 immediately, silently saving 0 for a field the user meant to retype.
  const [draft, setDraft] = useState(() => String(value));

  // External updates (Revert, quick presets) must win over a stale draft, but a draft
  // that already parses to the committed value is kept so typing is not reformatted.
  useEffect(() => {
    setDraft((current) => (current.trim() !== "" && Number(current) === value ? current : String(value)));
  }, [value]);

  return (
    <Labeled label={label} hint={hint}>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const parsed = Number(text);
          if (text.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
        }}
        onBlur={() => {
          if (draft.trim() === "" || !Number.isFinite(Number(draft))) setDraft(String(value));
        }}
      />
    </Labeled>
  );
}

function CommandPreviewBlock({ preview }: { preview: CommandPreview }) {
  const text = preview.argv.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" \\\n  ");
  return (
    <div className="command-preview">
      <div className="small-text muted">{preview.label ?? preview.provider}</div>
      <pre className="code-block">{text}</pre>
      {preview.env && preview.env.length > 0 && (
        <div className="small-text">
          env:{" "}
          {preview.env.map((entry) => (
            <code key={entry.name} className="chip">
              {entry.name}
              {entry.value !== undefined ? `=${entry.value}` : " (set)"}
            </code>
          ))}
        </div>
      )}
      {preview.stdin && <div className="small-text muted">{preview.stdin}</div>}
      <div className="row-actions">
        <CopyButton value={preview.argv.join(" ")} label="Copy command" />
      </div>
    </div>
  );
}

function AppRules() {
  const toast = useToast();
  const rules = useAsync((signal) => api.listAppProfiles(signal), []);
  const [draft, setDraft] = useState({ bundleId: "", appName: "", profile: "smart" as FormattingProfile });
  const [busy, setBusy] = useState(false);

  const items = rules.data?.items ?? [];

  const upsert = async (profile: AppProfile) => {
    setBusy(true);
    try {
      await api.putAppProfile(profile);
      rules.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!draft.bundleId.trim()) {
      toast.error("Bundle id is required");
      return;
    }
    await upsert({
      bundleId: draft.bundleId.trim(),
      appName: draft.appName.trim() || undefined,
      profile: draft.profile,
      builtin: false,
    });
    setDraft({ bundleId: "", appName: "", profile: "smart" });
  };

  const remove = async (bundleId: string) => {
    setBusy(true);
    try {
      await api.deleteAppProfile(bundleId);
      rules.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="table-scroll short">
        <table className="table">
          <thead>
            <tr>
              <th>Bundle id</th>
              <th>App</th>
              <th>Profile</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !rules.loading && (
              <tr>
                <td colSpan={4} className="muted center">
                  No per-app rules. Every app uses the default profile.
                </td>
              </tr>
            )}
            {items.map((rule) => (
              <tr key={rule.bundleId}>
                <td className="mono small-text">{rule.bundleId}</td>
                <td>{rule.appName ?? EM_DASH}</td>
                <td>
                  <select
                    value={rule.profile}
                    disabled={busy}
                    onChange={(event) =>
                      void upsert({ ...rule, profile: event.target.value as FormattingProfile })
                    }
                  >
                    {FormattingProfileSchema.options.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="col-actions">
                  {rule.builtin && <StatusPill tone="neutral">builtin</StatusPill>}
                  <button type="button" className="small danger" disabled={busy} onClick={() => void remove(rule.bundleId)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="filters">
        <Labeled label="Bundle id">
          <input
            value={draft.bundleId}
            placeholder="com.microsoft.VSCode"
            onChange={(event) => setDraft({ ...draft, bundleId: event.target.value })}
          />
        </Labeled>
        <Labeled label="App name (optional)">
          <input
            value={draft.appName}
            placeholder="Visual Studio Code"
            onChange={(event) => setDraft({ ...draft, appName: event.target.value })}
          />
        </Labeled>
        <Labeled label="Profile">
          <select
            value={draft.profile}
            onChange={(event) => setDraft({ ...draft, profile: event.target.value as FormattingProfile })}
          >
            {FormattingProfileSchema.options.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Labeled>
        <button type="button" onClick={() => void add()} disabled={busy}>
          Add rule
        </button>
      </div>
    </div>
  );
}

export function Settings() {
  const toast = useToast();
  const settings = useAsync((signal) => api.getSettings(signal), []);
  const presets = useAsync((signal) => api.listProviderPresets(signal), []);
  const capabilities = useAsync((signal) => api.providerCapabilities(signal), []);
  const prompt = useAsync((signal) => api.getPrompt(signal), []);

  const [draft, setDraft] = useState<SettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestProviderResult | undefined>(undefined);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | undefined>(undefined);
  const [showCommand, setShowCommand] = useState(false);
  const [serverPreview, setServerPreview] = useState<DiagnosticsReport["commandPreview"]>(undefined);
  const [confirmAction, setConfirmAction] = useState<"none" | "history" | "audio">("none");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const provider = draft?.correction.provider ?? "claude-cli";
  const model = draft?.correction.model ?? "";
  const effort = draft?.correction.effort ?? "";

  useEffect(() => {
    const stored = window.localStorage.getItem(`${LAST_CHECK_PREFIX}${provider}:${model}`);
    setLastCheckedAt(stored ?? undefined);
  }, [provider, model]);

  // The test banner describes one exact provider/model/effort combination; once any
  // of them changes it would vouch for a model that was never tested.
  useEffect(() => {
    setTestResult(undefined);
  }, [provider, model, effort]);

  // Kept current on every render so an in-flight test can tell whether the combination
  // it started for is still the one on screen.
  const comboRef = useRef("");
  comboRef.current = `${provider}\u0000${model}\u0000${effort}`;

  const efforts = useMemo(() => effortsFor(provider, capabilities.data), [provider, capabilities.data]);
  const fallbackEfforts = useMemo(
    () => effortsFor(draft?.correction.fallbackProvider ?? "openai-codex-cli", capabilities.data),
    [draft?.correction.fallbackProvider, capabilities.data],
  );

  const providerPresets = useMemo(
    () => (presets.data?.items ?? []).filter((preset) => preset.provider === provider),
    [presets.data, provider],
  );

  const dirty = useMemo(
    () => draft !== null && settings.data !== undefined && JSON.stringify(draft) !== JSON.stringify(settings.data),
    [draft, settings.data],
  );

  if (!draft) {
    return (
      <div className="page">
        <Toolbar>
          <h1 className="page-title">Settings</h1>
        </Toolbar>
        {settings.error !== undefined ? (
          <div className="banner banner-fail">{errorMessage(settings.error)}</div>
        ) : (
          <Spinner label="Loading settings…" />
        )}
      </div>
    );
  }

  const patchGeneral = (patch: Partial<SettingsData["general"]>) =>
    setDraft((current) => (current ? { ...current, general: { ...current.general, ...patch } } : current));
  const patchStt = (patch: Partial<SettingsData["stt"]>) =>
    setDraft((current) => (current ? { ...current, stt: { ...current.stt, ...patch } } : current));
  const patchCorrection = (patch: Partial<SettingsData["correction"]>) =>
    setDraft((current) => (current ? { ...current, correction: { ...current.correction, ...patch } } : current));
  const patchPrivacy = (patch: Partial<SettingsData["privacy"]>) =>
    setDraft((current) => (current ? { ...current, privacy: { ...current.privacy, ...patch } } : current));

  const save = async () => {
    const base = settings.data;
    if (!base) return;
    const patch: SettingsPatch = {};
    if (JSON.stringify(draft.general) !== JSON.stringify(base.general)) patch.general = draft.general;
    if (JSON.stringify(draft.stt) !== JSON.stringify(base.stt)) patch.stt = draft.stt;
    if (JSON.stringify(draft.correction) !== JSON.stringify(base.correction)) patch.correction = draft.correction;
    if (JSON.stringify(draft.privacy) !== JSON.stringify(base.privacy)) patch.privacy = draft.privacy;

    setSaving(true);
    try {
      const next = await api.patchSettings(patch);
      settings.setData(next);
      setDraft(next);
      toast.success("Settings saved");

      // A model id the user typed by hand is remembered so it reappears as a preset.
      const known = (presets.data?.items ?? []).some(
        (preset) => preset.provider === next.correction.provider && preset.model === next.correction.model,
      );
      if (!known && next.correction.model.trim().length > 0) {
        try {
          await api.createProviderPreset({
            provider: next.correction.provider,
            model: next.correction.model,
            effort: next.correction.effort,
            label: next.correction.model,
          });
          presets.reload();
        } catch (error) {
          toast.info(`Model saved in settings, but not stored as a preset: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const testModel = async () => {
    // The fields stay editable while the test runs; a verdict for a combination the user
    // has since changed must be dropped, not pinned under the new one.
    const startedFor = comboRef.current;
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await api.testProvider({
        provider: draft.correction.provider,
        model: draft.correction.model,
        effort: draft.correction.effort,
      });
      if (comboRef.current !== startedFor) return;
      setTestResult(result);
      if (result.ok) {
        const now = new Date().toISOString();
        window.localStorage.setItem(`${LAST_CHECK_PREFIX}${provider}:${model}`, now);
        setLastCheckedAt(now);
        toast.success(`Model responded in ${formatMs(result.latencyMs)}`);
      } else {
        toast.error(result.error ?? "The model did not answer");
      }
    } catch (error) {
      if (comboRef.current !== startedFor) return;
      setTestResult({ ok: false, error: errorMessage(error) });
      toast.error(errorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  const toggleCommandPreview = async (value: boolean) => {
    setShowCommand(value);
    if (!value || serverPreview) return;
    try {
      const report = await api.diagnostics();
      if (report.commandPreview && report.commandPreview.length > 0) setServerPreview(report.commandPreview);
    } catch {
      // Reconstructed preview is shown instead; no need to bother the user.
    }
  };

  const resetPrompt = async () => {
    try {
      await api.resetPrompt();
      patchCorrection({ customSystemPrompt: "" });
      const next = await api.patchSettings({ correction: { customSystemPrompt: "" } });
      settings.setData(next);
      setDraft(next);
      prompt.reload();
      toast.success("System prompt reset to the shipped version");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const exportLocalData = async () => {
    setExporting(true);
    try {
      const [history, dictionary, currentSettings, profiles, presetList] = await Promise.all([
        api.dictationExportText("json"),
        api.dictionaryExportText("json"),
        api.getSettings(),
        api.listAppProfiles(),
        api.listProviderPresets(),
      ]);
      const bundle = {
        exportedAt: new Date().toISOString(),
        settings: currentSettings,
        appProfiles: profiles.items,
        providerPresets: presetList.items,
        dictionary: JSON.parse(dictionary) as unknown,
        history: JSON.parse(history) as unknown,
      };
      downloadText(
        `localvoiceflow-export-${stamp()}.json`,
        "application/json",
        JSON.stringify(bundle, null, 2),
      );
      toast.success("Local data exported");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const deleteAllHistory = async () => {
    try {
      await api.clearHistory();
      toast.success("History deleted");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirmAction("none");
    }
  };

  const deleteSavedAudio = async () => {
    try {
      const result = await api.deleteStoredAudio();
      toast.success(`Deleted ${result.deleted} audio file(s)`);
    } catch (error) {
      if (isApiError(error) && (error.status === 404 || error.status === 405)) {
        toast.error("This core build does not implement DELETE /api/dictations/audio yet.");
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setConfirmAction("none");
    }
  };

  const openDirectory = async (target: "data" | "logs" | "audio") => {
    try {
      await api.openDirectory(target);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const activeQuickPreset = detectQuickPreset(draft.correction);
  const commandPreview =
    serverPreview?.find((entry) => entry.provider === provider) ??
    buildCommandPreview({
      provider,
      model: draft.correction.model,
      effort: draft.correction.effort,
      disableThinking: draft.correction.disableThinking,
      timeoutMs: draft.correction.timeoutMs,
    });

  const providerOptions = Object.keys(PROVIDER_LABELS).filter(
    (id) => id !== "mock" || provider === "mock",
  );

  return (
    <div className="page">
      <Toolbar
        right={
          <>
            <button type="button" onClick={() => setDraft(settings.data ?? draft)} disabled={!dirty || saving}>
              Revert
            </button>
            <button type="button" className="primary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? <Spinner inline label="Saving…" /> : "Save changes"}
            </button>
          </>
        }
      >
        <h1 className="page-title">Settings</h1>
        {dirty && <StatusPill tone="warn">unsaved changes</StatusPill>}
      </Toolbar>

      <Card title="General">
        <div className="form-grid">
          <Toggle label="Dictation enabled" checked={draft.general.enabled} onChange={(v) => patchGeneral({ enabled: v })} />
          <Toggle
            label="Start at login"
            checked={draft.general.startAtLogin}
            onChange={(v) => patchGeneral({ startAtLogin: v })}
          />
          <Toggle
            label="Open this dashboard when the app starts"
            checked={draft.general.launchDashboardOnStart}
            onChange={(v) => patchGeneral({ launchDashboardOnStart: v })}
          />
          <Toggle label="Show HUD while recording" checked={draft.general.hudEnabled} onChange={(v) => patchGeneral({ hudEnabled: v })} />
          <Toggle
            label="Sound feedback"
            checked={draft.general.soundFeedbackEnabled}
            onChange={(v) => patchGeneral({ soundFeedbackEnabled: v })}
          />
          <Toggle
            label="Клавиша Fn как push-to-talk"
            checked={draft.general.fnTriggerEnabled}
            onChange={(v) => patchGeneral({ fnTriggerEnabled: v })}
          />
          <Toggle
            label="Резервное сочетание включено"
            checked={draft.general.fallbackHotkeyEnabled}
            onChange={(v) => patchGeneral({ fallbackHotkeyEnabled: v })}
          />
          <Labeled
            label="Резервное сочетание"
            hint={
              <>
                Формат: модификаторы и клавиша через «+», например{" "}
                <code>control+option+space</code>, <code>command+shift+d</code>,{" "}
                <code>control+option+v</code>. Допустимые модификаторы: <code>control</code>,{" "}
                <code>option</code>, <code>shift</code>, <code>command</code>. Работает, даже
                когда Fn перехвачена системой.
              </>
            }
          >
            <input
              value={draft.general.fallbackHotkey}
              placeholder="control+option+space"
              onChange={(event) => patchGeneral({ fallbackHotkey: event.target.value })}
            />
          </Labeled>
          <NumberField
            label="Double-tap window (ms)"
            value={draft.general.doubleTapWindowMs}
            min={120}
            max={1000}
            onChange={(v) => patchGeneral({ doubleTapWindowMs: v })}
            hint="Two Fn taps within this window start locked recording."
          />
          <NumberField
            label="Minimum recording (ms)"
            value={draft.general.minRecordingMs}
            min={0}
            max={5000}
            onChange={(v) => patchGeneral({ minRecordingMs: v })}
          />
          <NumberField
            label="Maximum recording (s)"
            value={draft.general.maxRecordingSeconds}
            min={5}
            max={1800}
            onChange={(v) => patchGeneral({ maxRecordingSeconds: v })}
          />
          <Toggle
            label="End locked recording with Enter"
            checked={draft.general.endLockedRecordingWithEnter}
            onChange={(v) => patchGeneral({ endLockedRecordingWithEnter: v })}
          />
          <Labeled label="If the target app changed">
            <select
              value={draft.general.targetChangedBehavior}
              onChange={(event) =>
                patchGeneral({
                  targetChangedBehavior: event.target
                    .value as SettingsData["general"]["targetChangedBehavior"],
                })
              }
            >
              {TargetChangedBehaviorSchema.options.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Labeled>
          <Toggle
            label="Insert the raw transcript when the LLM fails"
            checked={draft.general.insertRawTranscriptWhenLlmFails}
            onChange={(v) => patchGeneral({ insertRawTranscriptWhenLlmFails: v })}
          />
          <Toggle
            label="Restore the clipboard after paste"
            checked={draft.general.restoreClipboardAfterPaste}
            onChange={(v) => patchGeneral({ restoreClipboardAfterPaste: v })}
          />
          <NumberField
            label="Clipboard restore delay (ms)"
            value={draft.general.clipboardRestoreDelayMs}
            min={50}
            max={5000}
            onChange={(v) => patchGeneral({ clipboardRestoreDelayMs: v })}
          />
        </div>
      </Card>

      <Card title="Speech-to-text">
        <div className="form-grid">
          <Labeled label="Backend">
            <select
              value={draft.stt.backend}
              onChange={(event) => patchStt({ backend: event.target.value as SettingsData["stt"]["backend"] })}
            >
              <option value="mlx-whisper">mlx-whisper (local, Apple Silicon GPU)</option>
              <option value="mock">mock (testing)</option>
            </select>
          </Labeled>
          <Labeled label="Model" wide>
            <input value={draft.stt.model} spellCheck={false} onChange={(event) => patchStt({ model: event.target.value })} />
          </Labeled>
          <Labeled label="Language">
            <select
              value={draft.stt.language}
              onChange={(event) => patchStt({ language: event.target.value as SettingsData["stt"]["language"] })}
            >
              {SttLanguageSchema.options.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Labeled>
          <Toggle
            label="Warm up the model at start"
            checked={draft.stt.warmUpOnStart}
            onChange={(v) => patchStt({ warmUpOnStart: v })}
            hint="Loads the 1.6 GB model once so the first dictation is not slow."
          />
          <Toggle
            label="Keep recorded audio on disk"
            checked={draft.stt.storeAudio}
            onChange={(v) => patchStt({ storeAudio: v })}
          />
          <Labeled label="Audio directory (empty = default)" wide>
            <input
              value={draft.stt.audioDirectory}
              spellCheck={false}
              onChange={(event) => patchStt({ audioDirectory: event.target.value })}
            />
          </Labeled>
          <NumberField
            label="Glossary characters in the Whisper prompt"
            value={draft.stt.glossaryPromptLimit}
            min={0}
            max={896}
            onChange={(v) => patchStt({ glossaryPromptLimit: v })}
          />
          <NumberField
            label="STT timeout (ms)"
            value={draft.stt.timeoutMs}
            min={1000}
            max={600000}
            step={500}
            onChange={(v) => patchStt({ timeoutMs: v })}
          />
          <NumberField
            label="Silence threshold (peak amplitude)"
            value={draft.stt.silenceThreshold}
            min={0}
            max={1}
            step={0.001}
            onChange={(v) => patchStt({ silenceThreshold: v })}
          />
        </div>
      </Card>

      <Card title="Text correction">
        <FieldRow label="Provider">
          <div className="radio-row">
            {providerOptions.map((id) => (
              <label key={id} className="radio">
                <input
                  type="radio"
                  name="provider"
                  checked={provider === id}
                  onChange={() =>
                    // A model id is provider-specific ("haiku" vs an MLX repo id), so
                    // switching providers swaps in that provider's defaults too.
                    patchCorrection({
                      provider: id as SettingsData["correction"]["provider"],
                      model: defaultModelFor(id),
                      effort: defaultEffortFor(id),
                    })
                  }
                />
                {providerLabel(id)}
              </label>
            ))}
          </div>
        </FieldRow>

        <FieldRow label="Quick preset" hint="Balanced targets the measured ≈2.5 s round trip; Quality trades latency for more careful editing.">
          <div className="button-row">
            <button
              type="button"
              className={activeQuickPreset === "balanced" ? "primary small" : "small"}
              onClick={() => patchCorrection({ ...QUICK_PRESETS.balanced })}
            >
              Balanced
            </button>
            <button
              type="button"
              className={activeQuickPreset === "quality" ? "primary small" : "small"}
              onClick={() =>
                patchCorrection({
                  ...QUICK_PRESETS.quality,
                  effort: efforts.includes(QUICK_PRESETS.quality.effort)
                    ? QUICK_PRESETS.quality.effort
                    : (efforts[efforts.length - 1] ?? draft.correction.effort),
                })
              }
            >
              Quality
            </button>
            <StatusPill tone={activeQuickPreset === "custom" ? "info" : "neutral"}>
              {activeQuickPreset === "custom" ? "custom" : `${activeQuickPreset} active`}
            </StatusPill>
          </div>
        </FieldRow>

        <FieldRow label="Model presets">
          <div className="chip-row">
            {providerPresets.length === 0 && <span className="muted">No presets stored for this provider.</span>}
            {providerPresets.map((preset) => (
              <span key={preset.id} className="chip-group">
                <button
                  type="button"
                  className={draft.correction.model === preset.model ? "primary small" : "small"}
                  onClick={() => patchCorrection({ model: preset.model, effort: preset.effort })}
                  title={`${preset.model} · effort ${preset.effort}`}
                >
                  {preset.label || preset.model}
                </button>
                {!preset.builtin && (
                  <button
                    type="button"
                    className="icon-button"
                    title="Forget this preset"
                    onClick={() => {
                      void api
                        .deleteProviderPreset(preset.id)
                        .then(() => presets.reload())
                        .catch((error: unknown) => toast.error(errorMessage(error)));
                    }}
                  >
                    ✕
                  </button>
                )}
              </span>
            ))}
          </div>
        </FieldRow>

        <div className="form-grid">
          <Labeled label="Model id (free text)" wide hint="Saved as a preset when you press Save changes.">
            <input
              value={draft.correction.model}
              spellCheck={false}
              placeholder="haiku"
              onChange={(event) => patchCorrection({ model: event.target.value })}
            />
          </Labeled>
          <Labeled label="Effort">
            <select value={draft.correction.effort} onChange={(event) => patchCorrection({ effort: event.target.value })}>
              {efforts.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
              {!efforts.includes(draft.correction.effort) && (
                <option value={draft.correction.effort}>{draft.correction.effort} (current)</option>
              )}
            </select>
          </Labeled>
          <Labeled label="Formatting profile (default)">
            <select
              value={draft.correction.profile}
              onChange={(event) => patchCorrection({ profile: event.target.value as FormattingProfile })}
            >
              {FormattingProfileSchema.options.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Labeled>
          <NumberField
            label="LLM timeout (ms), per attempt"
            value={draft.correction.timeoutMs}
            min={1000}
            max={300000}
            step={500}
            onChange={(v) => patchCorrection({ timeoutMs: v })}
          />
          <NumberField
            label="Glossary terms per request"
            value={draft.correction.glossaryMaxTerms}
            min={0}
            max={200}
            onChange={(v) => patchCorrection({ glossaryMaxTerms: v })}
          />
          <NumberField
            label="LLM attempts per dictation"
            value={draft.correction.maxAttempts}
            min={1}
            max={6}
            onChange={(v) => patchCorrection({ maxAttempts: v })}
          />
          <NumberField
            label="Retry backoff (ms)"
            value={draft.correction.retryBackoffMs}
            min={0}
            max={10000}
            step={100}
            onChange={(v) => patchCorrection({ retryBackoffMs: v })}
          />
          <Toggle
            label="Disable extended thinking"
            checked={draft.correction.disableThinking}
            onChange={(v) => patchCorrection({ disableThinking: v })}
            hint="Measured 4× faster on Claude with no loss in edit quality."
          />
          <Toggle
            label="Send the window title to the provider"
            checked={draft.correction.sendWindowTitle}
            onChange={(v) => patchCorrection({ sendWindowTitle: v })}
            hint="Off by default: window titles can leak private content."
          />
        </div>

        <FieldRow label="Test model">
          <div className="button-row">
            <button type="button" onClick={() => void testModel()} disabled={testing}>
              {testing ? <Spinner inline label="Calling the CLI…" /> : "Test model"}
            </button>
            <span className="muted small-text">
              Last successful check: {lastCheckedAt ? formatDateTime(lastCheckedAt) : "never"}
            </span>
          </div>
          {testResult && (
            <div className={testResult.ok ? "banner banner-ok" : "banner banner-fail"}>
              {testResult.ok ? (
                <>
                  <div>
                    <strong>{testResult.provider ?? provider}</strong> · {testResult.model ?? model} ·{" "}
                    {formatMs(testResult.latencyMs)}
                  </div>
                  {testResult.sample && <div className="text-block">{testResult.sample}</div>}
                </>
              ) : (
                <>
                  <div>
                    <strong>Model unavailable.</strong> {testResult.error ?? "The provider returned no answer."}
                  </div>
                  <div className="small-text">
                    Check the model id, or run the CLI once in a terminal to confirm the subscription is active.
                  </div>
                </>
              )}
            </div>
          )}
        </FieldRow>

        <FieldRow label="Fallback provider">
          <Toggle
            label="Use a fallback provider when the primary one fails"
            checked={draft.correction.fallbackProviderEnabled}
            onChange={(v) => patchCorrection({ fallbackProviderEnabled: v })}
          />
          {draft.correction.fallbackProviderEnabled && (
            <div className="form-grid">
              <Labeled label="Provider">
                <select
                  value={draft.correction.fallbackProvider}
                  onChange={(event) =>
                    patchCorrection({
                      fallbackProvider: event.target.value as SettingsData["correction"]["fallbackProvider"],
                      fallbackModel: defaultModelFor(event.target.value),
                      fallbackEffort: defaultEffortFor(event.target.value),
                    })
                  }
                >
                  {Object.keys(PROVIDER_LABELS).map((id) => (
                    <option key={id} value={id}>
                      {providerLabel(id)}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Model">
                <input
                  value={draft.correction.fallbackModel}
                  spellCheck={false}
                  onChange={(event) => patchCorrection({ fallbackModel: event.target.value })}
                />
              </Labeled>
              <Labeled label="Effort">
                <select
                  value={draft.correction.fallbackEffort}
                  onChange={(event) => patchCorrection({ fallbackEffort: event.target.value })}
                >
                  {fallbackEfforts.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Toggle
                label="Disable extended thinking on the fallback"
                checked={draft.correction.fallbackDisableThinking}
                onChange={(v) => patchCorrection({ fallbackDisableThinking: v })}
                hint="The fallback runs after the primary already spent its budget, so it is there to be fast."
              />
            </div>
          )}
        </FieldRow>

        <FieldRow label="Custom system prompt">
          <textarea
            rows={8}
            className="mono"
            spellCheck={false}
            value={draft.correction.customSystemPrompt}
            placeholder="Empty — the shipped prompt (prompts/transcription-editor.md) is used."
            onChange={(event) => patchCorrection({ customSystemPrompt: event.target.value })}
          />
          <div className="row-actions">
            <button
              type="button"
              className="small"
              disabled={!prompt.data}
              onClick={() => patchCorrection({ customSystemPrompt: prompt.data?.systemPrompt ?? "" })}
            >
              Load the active prompt into the editor
            </button>
            <button type="button" className="small" onClick={() => void resetPrompt()}>
              Reset to shipped prompt
            </button>
            {prompt.data && (
              <StatusPill tone={prompt.data.isCustom ? "info" : "neutral"}>
                {prompt.data.isCustom ? "custom prompt active" : "shipped prompt active"}
              </StatusPill>
            )}
          </div>
        </FieldRow>

        <FieldRow label="Per-app rules" hint="An explicit rule always wins over the built-in table.">
          <AppRules />
        </FieldRow>

        <FieldRow label="Safe command preview">
          <Toggle
            label="Show safe command preview"
            checked={showCommand}
            onChange={(v) => void toggleCommandPreview(v)}
            hint="Argv only — no dictated text, no tokens, no environment values beyond the two shown."
          />
          {showCommand && <CommandPreviewBlock preview={commandPreview} />}
        </FieldRow>
      </Card>

      <Card title="Privacy">
        <div className="privacy-statements">
          <p>{PRIVACY_LOCAL_AUDIO}</p>
          <p>{PRIVACY_LLM_SCOPE}</p>
        </div>
        <div className="form-grid">
          <Labeled label="Log level">
            <select
              value={draft.privacy.logLevel}
              onChange={(event) =>
                patchPrivacy({ logLevel: event.target.value as SettingsData["privacy"]["logLevel"] })
              }
            >
              {["error", "warn", "info", "debug"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Labeled>
        </div>
        <div className="button-row">
          <button type="button" className="danger" onClick={() => setConfirmAction("history")}>
            Delete all history
          </button>
          <button type="button" className="danger" onClick={() => setConfirmAction("audio")}>
            Delete saved audio
          </button>
          <button type="button" onClick={() => void exportLocalData()} disabled={exporting}>
            {exporting ? <Spinner inline label="Collecting…" /> : "Export local data"}
          </button>
          <button type="button" onClick={() => void openDirectory("data")}>
            Open data directory
          </button>
          <button type="button" onClick={() => void openDirectory("logs")}>
            Open logs directory
          </button>
        </div>
      </Card>

      <Card title="Diagnostics">
        <p className="muted">
          The doctor report lists the state of the STT worker, both CLIs, macOS permissions and the
          database. It shows the <em>names</em> of API-key environment variables that are set, never
          their values.
        </p>
        <div className="button-row">
          <Link className="button-link" to="/diagnostics">
            Open diagnostics
          </Link>
          <button type="button" onClick={() => void openDirectory("logs")}>
            Open logs directory
          </button>
          <button type="button" onClick={() => void openDirectory("audio")}>
            Open audio directory
          </button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmAction === "history"}
        title="Delete all history"
        message="Every dictation record will be removed from the local database. This cannot be undone."
        confirmLabel="Delete history"
        requirePhrase="delete"
        danger
        onConfirm={deleteAllHistory}
        onCancel={() => setConfirmAction("none")}
      />
      <ConfirmDialog
        open={confirmAction === "audio"}
        title="Delete saved audio"
        message="All stored WAV files are removed; the transcripts stay in history."
        confirmLabel="Delete audio"
        danger
        onConfirm={deleteSavedAudio}
        onCancel={() => setConfirmAction("none")}
      />
    </div>
  );
}
