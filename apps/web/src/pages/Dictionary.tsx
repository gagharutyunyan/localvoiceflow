import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DictionaryTerm, DictionaryTermInput, TermLanguage } from "@lvf/shared";
import { api, errorMessage } from "../api/client";
import { useAsync } from "../api/hooks";
import type { DictionaryPreview, GlossaryHit } from "../api/types";
import { Card, FieldRow } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyButton } from "../components/CopyButton";
import { Modal } from "../components/Modal";
import { Spinner } from "../components/Spinner";
import { StatusPill } from "../components/StatusPill";
import { Labeled, Toolbar } from "../components/Toolbar";
import { useToast } from "../components/Toast";
import { csvToTerms, jsonToTerms, parseCsv } from "../lib/csv";
import { EM_DASH } from "../lib/format";
import { withIdsSelected } from "../lib/selection";

const LANGUAGES: TermLanguage[] = ["ru", "en", "hy", "mixed"];

interface EditorState {
  id: string | null;
  canonical: string;
  aliases: string;
  category: string;
  language: string;
  notes: string;
  enabled: boolean;
  priority: string;
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  canonical: "",
  aliases: "",
  category: "",
  language: "",
  notes: "",
  enabled: true,
  priority: "0",
};

function editorFromTerm(term: DictionaryTerm): EditorState {
  return {
    id: term.id,
    canonical: term.canonical,
    aliases: term.aliases.join("\n"),
    category: term.category ?? "",
    language: term.language ?? "",
    notes: term.notes ?? "",
    enabled: term.enabled,
    priority: String(term.priority),
  };
}

function editorToInput(editor: EditorState): DictionaryTermInput {
  const aliases = editor.aliases
    .split(/[\n,;|]/)
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
  const language = LANGUAGES.find((value) => value === editor.language);
  const priority = Number.parseInt(editor.priority, 10);
  return {
    canonical: editor.canonical.trim(),
    aliases,
    enabled: editor.enabled,
    category: editor.category.trim() || null,
    language: language ?? null,
    notes: editor.notes.trim() || null,
    priority: Number.isFinite(priority) ? Math.min(Math.max(priority, 0), 100) : 0,
  };
}

function normalize(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
}

interface DuplicateNote {
  canonical: string;
  reason: string;
}

/** Duplicate detection shown before an import is committed. */
function findDuplicates(
  incoming: readonly DictionaryTermInput[],
  existing: readonly DictionaryTerm[],
): DuplicateNote[] {
  const byCanonical = new Map<string, DictionaryTerm>();
  const byAlias = new Map<string, DictionaryTerm>();
  for (const term of existing) {
    byCanonical.set(normalize(term.canonical), term);
    for (const alias of term.aliases) byAlias.set(normalize(alias), term);
  }

  const notes: DuplicateNote[] = [];
  const seen = new Set<string>();

  for (const term of incoming) {
    const key = normalize(term.canonical);
    if (seen.has(key)) {
      notes.push({ canonical: term.canonical, reason: "appears more than once in the file" });
      continue;
    }
    seen.add(key);

    const existingTerm = byCanonical.get(key);
    if (existingTerm) {
      notes.push({ canonical: term.canonical, reason: "already in the dictionary — will be updated" });
      continue;
    }
    const aliasOwner = byAlias.get(key);
    if (aliasOwner) {
      notes.push({
        canonical: term.canonical,
        reason: `collides with an alias of "${aliasOwner.canonical}"`,
      });
      continue;
    }
    for (const alias of term.aliases) {
      const owner = byAlias.get(normalize(alias)) ?? byCanonical.get(normalize(alias));
      if (owner && normalize(owner.canonical) !== key) {
        notes.push({
          canonical: term.canonical,
          reason: `alias "${alias}" is already used by "${owner.canonical}"`,
        });
        break;
      }
    }
  }

  return notes;
}

interface ImportState {
  fileName: string;
  terms: DictionaryTermInput[];
  duplicates: DuplicateNote[];
  mode: "merge" | "replace";
}

function highlightHits(text: string, hits: readonly GlossaryHit[]): ReactNode[] {
  const usable = hits
    .filter((hit) => hit.index >= 0 && hit.index + hit.alias.length <= text.length)
    .slice()
    .sort((a, b) => a.index - b.index);

  const nodes: ReactNode[] = [];
  let cursor = 0;
  usable.forEach((hit, position) => {
    if (hit.index < cursor) return;
    if (hit.index > cursor) nodes.push(text.slice(cursor, hit.index));
    const end = hit.index + hit.alias.length;
    nodes.push(
      <mark key={`${hit.index}-${position}`} title={`→ ${hit.canonical}`}>
        {text.slice(hit.index, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function PreviewPanel() {
  const toast = useToast();
  const [rawTranscript, setRawTranscript] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<DictionaryPreview | undefined>(undefined);

  const run = async () => {
    setBusy(true);
    try {
      const result = await api.previewDictionary({
        rawTranscript,
        ...(bundleId.trim() ? { bundleId: bundleId.trim() } : {}),
      });
      setPreview(result);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Test panel"
      subtitle="Runs the same glossary selection and payload builder the pipeline uses. Nothing is sent to a provider."
    >
      <Labeled label="Raw transcript" wide>
        <textarea
          rows={4}
          value={rawTranscript}
          spellCheck={false}
          placeholder="Так смотри, этот юз эффект дергает апи…"
          onChange={(event) => setRawTranscript(event.target.value)}
        />
      </Labeled>
      <div className="filters">
        <Labeled label="Target app (bundle id, optional)">
          <input
            value={bundleId}
            placeholder="com.microsoft.VSCode"
            onChange={(event) => setBundleId(event.target.value)}
          />
        </Labeled>
        <button
          type="button"
          className="primary"
          onClick={() => void run()}
          disabled={busy || rawTranscript.trim().length === 0}
        >
          {busy ? <Spinner inline label="Previewing…" /> : "Preview"}
        </button>
      </div>

      {preview && (
        <div className="preview">
          <FieldRow label="Profile">{preview.profile}</FieldRow>
          <FieldRow label="Hits">
            {preview.hits.length === 0 ? (
              <span className="muted">no deterministic replacements</span>
            ) : (
              <ul className="plain-list">
                {preview.hits.map((hit, index) => (
                  <li key={`${hit.alias}-${hit.index}-${index}`}>
                    <code>{hit.alias}</code> → <code>{hit.canonical}</code>{" "}
                    <span className="muted small-text">at {hit.index}</span>
                  </li>
                ))}
              </ul>
            )}
          </FieldRow>
          <FieldRow label="Raw with hits">
            <div className="text-block">{highlightHits(preview.rawTranscript, preview.hits)}</div>
          </FieldRow>
          <FieldRow label="After replacements">
            <div className="text-block">{preview.afterReplacements}</div>
          </FieldRow>
          {preview.skipped.length > 0 && (
            <FieldRow
              label="Skipped aliases"
              hint="Too short or too ambiguous for deterministic replacement — still sent to the LLM as context."
            >
              {preview.skipped.map((alias) => (
                <code key={alias} className="chip">
                  {alias}
                </code>
              ))}
            </FieldRow>
          )}
          <FieldRow label="Selected glossary">
            {preview.glossary.length === 0 ? (
              <span className="muted">empty</span>
            ) : (
              <ul className="plain-list">
                {preview.glossary.map((entry) => (
                  <li key={entry.canonical}>
                    <strong>{entry.canonical}</strong>
                    {entry.aliases.length > 0 && (
                      <span className="muted"> — {entry.aliases.join(", ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </FieldRow>
          <FieldRow label="STT initial prompt">
            <pre className="code-block">{preview.sttInitialPrompt || EM_DASH}</pre>
          </FieldRow>
          <FieldRow label="LLM payload (exact stdin)">
            <pre className="code-block scroll">{preview.promptPreview}</pre>
            <div className="row-actions">
              <CopyButton value={preview.promptPreview} label="Copy payload" />
            </div>
          </FieldRow>
        </div>
      )}
    </Card>
  );
}

export function Dictionary() {
  const toast = useToast();
  const list = useAsync((signal) => api.listDictionary(signal), []);
  const terms = useMemo(() => list.data?.items ?? [], [list.data]);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [enabledFilter, setEnabledFilter] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DictionaryTerm | null>(null);
  const [importState, setImportState] = useState<ImportState | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const categories = useMemo(() => {
    const found = new Set<string>();
    for (const term of terms) if (term.category) found.add(term.category);
    return [...found].sort();
  }, [terms]);

  const visible = useMemo(() => {
    const needle = normalize(search);
    return terms.filter((term) => {
      if (category && term.category !== category) return false;
      if (enabledFilter === "enabled" && !term.enabled) return false;
      if (enabledFilter === "disabled" && term.enabled) return false;
      if (!needle) return true;
      if (normalize(term.canonical).includes(needle)) return true;
      if (term.aliases.some((alias) => normalize(alias).includes(needle))) return true;
      if (term.notes && normalize(term.notes).includes(needle)) return true;
      return false;
    });
  }, [terms, search, category, enabledFilter]);

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveTerm = async () => {
    if (!editor) return;
    const input = editorToInput(editor);
    if (input.canonical.length === 0) {
      toast.error("Canonical form is required");
      return;
    }
    setSaving(true);
    try {
      if (editor.id) await api.updateTerm(editor.id, input);
      else await api.createTerm(input);
      setEditor(null);
      list.reload();
      toast.success(editor.id ? "Term updated" : "Term added");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (term: DictionaryTerm) => {
    try {
      const next = await api.updateTerm(term.id, { enabled: !term.enabled });
      list.setData((current) =>
        current
          ? { items: current.items.map((item) => (item.id === next.id ? next : item)) }
          : current,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const bulkEnable = async (enabled: boolean) => {
    try {
      const result = await api.bulkSetEnabled([...selected], enabled);
      toast.success(`${result.updated} terms ${enabled ? "enabled" : "disabled"}`);
      list.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const removeTerm = async (term: DictionaryTerm) => {
    try {
      await api.deleteTerm(term.id);
      list.setData((current) =>
        current ? { items: current.items.filter((item) => item.id !== term.id) } : current,
      );
      // A deleted term must not linger in the selection: it is invisible to the header
      // checkbox, so nothing else would ever clear it.
      setSelected((current) => withIdsSelected(current, [term.id], false));
      toast.success("Term deleted");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPendingDelete(null);
    }
  };

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const isCsv = /\.csv$/i.test(file.name);
      let parsed: DictionaryTermInput[];
      if (isCsv) {
        parsed = csvToTerms(parseCsv(text));
      } else {
        try {
          parsed = jsonToTerms(text);
        } catch {
          // A .txt/.tsv export is far more likely than a malformed JSON file here.
          parsed = csvToTerms(parseCsv(text));
        }
      }
      if (parsed.length === 0) {
        toast.error("No usable terms found in that file");
        return;
      }
      setImportState({
        fileName: file.name,
        terms: parsed,
        duplicates: findDuplicates(parsed, terms),
        mode: "merge",
      });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const commitImport = async () => {
    if (!importState) return;
    setImporting(true);
    try {
      const result = await api.importDictionary({
        terms: importState.terms,
        mode: importState.mode,
      });
      toast.success(
        `Imported: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`,
      );
      // Replace mode recreates every term with fresh ids, so the old selection is all phantoms.
      if (importState.mode === "replace") setSelected(new Set());
      setImportState(null);
      list.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="page">
      <Toolbar
        right={
          <>
            <button type="button" className="primary" onClick={() => setEditor(EMPTY_EDITOR)}>
              Add term
            </button>
            <button type="button" onClick={() => fileInput.current?.click()}>
              Import JSON / CSV
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,.csv,application/json,text/csv,text/plain"
              hidden
              onChange={(event) => void onFileChosen(event.target.files?.[0])}
            />
            <a className="button-link" href={api.dictionaryExportUrl("json")} download>
              Export JSON
            </a>
            <a className="button-link" href={api.dictionaryExportUrl("csv")} download>
              Export CSV
            </a>
          </>
        }
      >
        <h1 className="page-title">Dictionary</h1>
        {list.loading && <Spinner inline label="Loading…" />}
      </Toolbar>

      {list.error !== undefined && <div className="banner banner-fail">{errorMessage(list.error)}</div>}

      <Card>
        <div className="filters">
          <Labeled label="Search" wide>
            <input
              value={search}
              placeholder="canonical, alias or note"
              onChange={(event) => setSearch(event.target.value)}
            />
          </Labeled>
          <Labeled label="Category">
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">all</option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="State">
            <select value={enabledFilter} onChange={(event) => setEnabledFilter(event.target.value)}>
              <option value="">all</option>
              <option value="enabled">enabled</option>
              <option value="disabled">disabled</option>
            </select>
          </Labeled>
        </div>
      </Card>

      <Card
        title={`${visible.length} of ${terms.length} terms`}
        actions={
          <>
            <span className="muted small-text">{selected.size} selected</span>
            <button type="button" className="small" disabled={selected.size === 0} onClick={() => void bulkEnable(true)}>
              Enable
            </button>
            <button
              type="button"
              className="small"
              disabled={selected.size === 0}
              onClick={() => void bulkEnable(false)}
            >
              Disable
            </button>
          </>
        }
      >
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label="Select all listed terms"
                    checked={visible.length > 0 && visible.every((term) => selected.has(term.id))}
                    onChange={(event) =>
                      setSelected((current) =>
                        withIdsSelected(current, visible.map((term) => term.id), event.target.checked),
                      )
                    }
                  />
                </th>
                <th>Canonical</th>
                <th>Aliases</th>
                <th>Category</th>
                <th>Lang</th>
                <th>Prio</th>
                <th>State</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && !list.loading && (
                <tr>
                  <td colSpan={8} className="muted center">
                    No terms match.
                  </td>
                </tr>
              )}
              {visible.map((term) => (
                <tr key={term.id}>
                  <td className="col-check">
                    <input
                      type="checkbox"
                      aria-label={`Select ${term.canonical}`}
                      checked={selected.has(term.id)}
                      onChange={() => toggleSelected(term.id)}
                    />
                  </td>
                  <td>
                    <strong>{term.canonical}</strong>
                    {term.notes && <div className="small-text muted">{term.notes}</div>}
                  </td>
                  <td className="small-text">{term.aliases.join(", ") || EM_DASH}</td>
                  <td>{term.category ?? EM_DASH}</td>
                  <td>{term.language ?? EM_DASH}</td>
                  <td>{term.priority > 0 ? term.priority : EM_DASH}</td>
                  <td>
                    <StatusPill tone={term.enabled ? "ok" : "neutral"}>
                      {term.enabled ? "enabled" : "disabled"}
                    </StatusPill>
                  </td>
                  <td className="col-actions">
                    <button type="button" className="small" onClick={() => void toggleEnabled(term)}>
                      {term.enabled ? "Disable" : "Enable"}
                    </button>
                    <button type="button" className="small" onClick={() => setEditor(editorFromTerm(term))}>
                      Edit
                    </button>
                    <button type="button" className="small danger" onClick={() => setPendingDelete(term)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <PreviewPanel />

      <Modal
        open={editor !== null}
        title={editor?.id ? "Edit term" : "Add term"}
        onClose={() => setEditor(null)}
        footer={
          <>
            <button type="button" onClick={() => setEditor(null)} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => void saveTerm()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        }
      >
        {editor && (
          <div className="form-grid">
            <Labeled label="Canonical form" wide>
              <input
                value={editor.canonical}
                autoFocus
                onChange={(event) => setEditor({ ...editor, canonical: event.target.value })}
              />
            </Labeled>
            <Labeled label="Aliases (one per line)" wide>
              <textarea
                rows={4}
                value={editor.aliases}
                spellCheck={false}
                onChange={(event) => setEditor({ ...editor, aliases: event.target.value })}
              />
            </Labeled>
            <Labeled label="Category">
              <input
                value={editor.category}
                list="dictionary-categories"
                onChange={(event) => setEditor({ ...editor, category: event.target.value })}
              />
              <datalist id="dictionary-categories">
                {categories.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </Labeled>
            <Labeled label="Language">
              <select
                value={editor.language}
                onChange={(event) => setEditor({ ...editor, language: event.target.value })}
              >
                <option value="">unspecified</option>
                {LANGUAGES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label="STT prompt priority (0–100)">
              <input
                type="number"
                min={0}
                max={100}
                value={editor.priority}
                onChange={(event) => setEditor({ ...editor, priority: event.target.value })}
              />
              <div className="small-text muted">
                Whisper's hint holds only ~20 terms. Higher wins a slot; 0 means the term is
                corrected afterwards instead.
              </div>
            </Labeled>
            <Labeled label="Notes" wide>
              <textarea
                rows={2}
                value={editor.notes}
                onChange={(event) => setEditor({ ...editor, notes: event.target.value })}
              />
            </Labeled>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={editor.enabled}
                onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })}
              />
              Enabled
            </label>
          </div>
        )}
      </Modal>

      <Modal
        open={importState !== null}
        size="wide"
        title={`Import ${importState?.fileName ?? ""}`}
        onClose={() => setImportState(null)}
        footer={
          <>
            <button type="button" onClick={() => setImportState(null)} disabled={importing}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => void commitImport()} disabled={importing}>
              {importing ? "Importing…" : `Import ${importState?.terms.length ?? 0} terms`}
            </button>
          </>
        }
      >
        {importState && (
          <>
            <div className="filters">
              <Labeled label="Mode">
                <select
                  value={importState.mode}
                  onChange={(event) =>
                    setImportState({
                      ...importState,
                      mode: event.target.value === "replace" ? "replace" : "merge",
                    })
                  }
                >
                  <option value="merge">merge — update existing, add new</option>
                  <option value="replace">replace — wipe the dictionary first</option>
                </select>
              </Labeled>
            </div>

            {importState.duplicates.length > 0 ? (
              <div className="banner banner-warn">
                <strong>{importState.duplicates.length} duplicate(s) detected.</strong>
                <ul className="plain-list">
                  {importState.duplicates.slice(0, 20).map((note, index) => (
                    <li key={`${note.canonical}-${index}`}>
                      <code>{note.canonical}</code> — {note.reason}
                    </li>
                  ))}
                </ul>
                {importState.duplicates.length > 20 && (
                  <p className="small-text">…and {importState.duplicates.length - 20} more.</p>
                )}
              </div>
            ) : (
              <div className="banner banner-ok">No duplicates detected.</div>
            )}

            <div className="table-scroll short">
              <table className="table">
                <thead>
                  <tr>
                    <th>Canonical</th>
                    <th>Aliases</th>
                    <th>Category</th>
                    <th>Lang</th>
                    <th>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {importState.terms.slice(0, 200).map((term, index) => (
                    <tr key={`${term.canonical}-${index}`}>
                      <td>{term.canonical}</td>
                      <td className="small-text">{term.aliases.join(", ")}</td>
                      <td>{term.category ?? EM_DASH}</td>
                      <td>{term.language ?? EM_DASH}</td>
                      <td>{term.enabled ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {importState.terms.length > 200 && (
              <p className="muted small-text">Showing the first 200 of {importState.terms.length} terms.</p>
            )}
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete term"
        message={
          <>
            Delete <strong>{pendingDelete?.canonical}</strong> and its aliases?
          </>
        }
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (pendingDelete) await removeTerm(pendingDelete);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
