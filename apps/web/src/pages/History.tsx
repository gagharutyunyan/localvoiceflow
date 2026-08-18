import { Fragment, useEffect, useMemo, useState } from "react";
import { DictationStatusSchema } from "@lvf/shared";
import type { DictationRecord } from "@lvf/shared";
import { api, errorMessage } from "../api/client";
import { useAsync, useDebouncedValue } from "../api/hooks";
import type { ProviderCapability } from "../api/types";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyButton } from "../components/CopyButton";
import { Spinner } from "../components/Spinner";
import { StatusPill, dictationStatusTone } from "../components/StatusPill";
import { Labeled, Toolbar } from "../components/Toolbar";
import { useToast } from "../components/Toast";
import { EM_DASH, formatDateTimeShort, formatMs, fromDateTimeLocal } from "../lib/format";
import { PROVIDER_LABELS, effortsFor } from "../lib/providers";
import { withIdsSelected } from "../lib/selection";

const PAGE_SIZE = 50;

interface FilterState {
  q: string;
  status: string;
  bundleId: string;
  llmProvider: string;
  llmModel: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: FilterState = {
  q: "",
  status: "",
  bundleId: "",
  llmProvider: "",
  llmModel: "",
  from: "",
  to: "",
};

function RecordDetail({
  record,
  capabilities,
  onChanged,
}: {
  record: DictationRecord;
  capabilities: ProviderCapability[] | null | undefined;
  onChanged: (next: DictationRecord) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState(record.finalText ?? "");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<"none" | "current" | "custom">("none");
  const [provider, setProvider] = useState(record.llmProvider ?? "claude-cli");
  const [model, setModel] = useState(record.llmModel ?? "");
  const [effort, setEffort] = useState(record.llmEffort ?? "");

  useEffect(() => {
    setDraft(record.finalText ?? "");
  }, [record.id, record.updatedAt, record.finalText]);

  const efforts = effortsFor(provider, capabilities);

  const save = async () => {
    setSaving(true);
    try {
      onChanged(await api.updateDictation(record.id, draft));
      toast.success("Final text saved");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const reprocess = async (custom: boolean) => {
    setBusy(custom ? "custom" : "current");
    try {
      const body = custom
        ? {
            provider,
            ...(model.trim() ? { model: model.trim() } : {}),
            ...(effort ? { effort } : {}),
          }
        : {};
      const next = await api.reprocess(record.id, body);
      onChanged(next);
      toast.success(`Reprocessed with ${next.llmModel ?? "the current model"}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("none");
    }
  };

  return (
    <div className="detail">
      <div className="detail-columns">
        <div className="detail-column">
          <div className="detail-head">
            <h4>Raw transcript</h4>
            <CopyButton value={record.rawTranscript} label="Copy raw" />
          </div>
          <div className="text-block scroll">{record.rawTranscript || <span className="muted">empty</span>}</div>
        </div>
        <div className="detail-column">
          <div className="detail-head">
            <h4>Final text</h4>
            <CopyButton value={record.finalText} label="Copy final" />
          </div>
          <textarea
            className="text-edit"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={8}
            spellCheck={false}
          />
          <div className="row-actions">
            <button
              type="button"
              className="primary small"
              onClick={() => void save()}
              disabled={saving || draft === (record.finalText ?? "")}
            >
              {saving ? "Saving…" : "Save edit"}
            </button>
            <button
              type="button"
              className="small"
              onClick={() => setDraft(record.finalText ?? "")}
              disabled={draft === (record.finalText ?? "")}
            >
              Revert
            </button>
          </div>
        </div>
      </div>

      <div className="detail-meta">
        <span>
          STT <strong>{formatMs(record.sttLatencyMs)}</strong>
        </span>
        <span>
          LLM <strong>{formatMs(record.llmLatencyMs)}</strong>
        </span>
        <span>
          Total <strong>{formatMs(record.totalLatencyMs)}</strong>
        </span>
        <span>
          Audio <strong>{formatMs(record.audioDurationMs)}</strong>
        </span>
        <span>
          Mode <strong>{record.recordingMode}</strong>
        </span>
        <span>
          STT model <strong className="mono">{record.sttModel ?? EM_DASH}</strong>
        </span>
        <span>
          Language <strong>{record.detectedLanguage ?? EM_DASH}</strong>
        </span>
      </div>

      {record.warnings && record.warnings.length > 0 && (
        <div className="banner banner-warn">{record.warnings.join(" · ")}</div>
      )}
      {record.errorCode && (
        <div className="banner banner-fail">
          {record.errorCode}: {record.errorMessage ?? ""}
        </div>
      )}

      {record.audioPath && (
        <div className="audio-block">
          <h4>Saved audio</h4>
          <audio controls preload="none" src={api.dictationAudioUrl(record.id)} />
        </div>
      )}

      <div className="reprocess">
        <h4>Reprocess</h4>
        <div className="reprocess-row">
          <button
            type="button"
            onClick={() => void reprocess(false)}
            disabled={busy !== "none" || !record.rawTranscript}
            title="Re-run correction using the currently configured provider, model and effort"
          >
            {busy === "current" ? <Spinner inline label="Working…" /> : "With current model"}
          </button>
        </div>
        <div className="reprocess-row">
          <Labeled label="Provider">
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              {Object.keys(PROVIDER_LABELS).map((id) => (
                <option key={id} value={id}>
                  {PROVIDER_LABELS[id]}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Model">
            <input
              value={model}
              placeholder="model id"
              onChange={(event) => setModel(event.target.value)}
              spellCheck={false}
            />
          </Labeled>
          <Labeled label="Effort">
            <select value={effort} onChange={(event) => setEffort(event.target.value)}>
              <option value="">(current)</option>
              {efforts.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Labeled>
          <button
            type="button"
            onClick={() => void reprocess(true)}
            disabled={busy !== "none" || !record.rawTranscript}
          >
            {busy === "custom" ? <Spinner inline label="Working…" /> : "Reprocess"}
          </button>
        </div>
        {!record.rawTranscript && (
          <p className="muted small-text">This record has no raw transcript, so it cannot be reprocessed.</p>
        )}
      </div>
    </div>
  );
}

export function History() {
  const toast = useToast();
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<"none" | "bulk" | "all" | { id: string }>("none");

  const debouncedQuery = useDebouncedValue(filters.q, 250);
  const capabilities = useAsync((signal) => api.providerCapabilities(signal), []);

  const list = useAsync(
    (signal) =>
      api.listDictations(
        {
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          bundleId: filters.bundleId || undefined,
          llmProvider: filters.llmProvider || undefined,
          llmModel: filters.llmModel || undefined,
          from: fromDateTimeLocal(filters.from),
          to: fromDateTimeLocal(filters.to),
          limit: PAGE_SIZE,
          offset,
        },
        signal,
      ),
    [
      debouncedQuery,
      filters.status,
      filters.bundleId,
      filters.llmProvider,
      filters.llmModel,
      filters.from,
      filters.to,
      offset,
    ],
  );

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  // Deletions can leave the page offset past the end of the shrunken list; snap back to
  // the last page that still has rows instead of showing an empty table.
  useEffect(() => {
    if (list.data && offset > 0 && offset >= total) {
      setOffset(total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
    }
  }, [list.data, offset, total]);

  const suggestions = useMemo(() => {
    const bundles = new Set<string>();
    const providers = new Set<string>();
    const models = new Set<string>();
    for (const item of items) {
      if (item.bundleId) bundles.add(item.bundleId);
      if (item.llmProvider) providers.add(item.llmProvider);
      if (item.llmModel) models.add(item.llmModel);
    }
    return { bundles: [...bundles], providers: [...providers], models: [...models] };
  }, [items]);

  const update = (patch: Partial<FilterState>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  };

  const toggle = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const replaceRecord = (next: DictationRecord) => {
    list.setData((current) =>
      current
        ? { ...current, items: current.items.map((item) => (item.id === next.id ? next : item)) }
        : current,
    );
  };

  // The optimistic local removal keeps the table responsive, but only the reload in
  // deleteOne/deleteSelected brings offset and total back in sync with the server —
  // without it "Older →" would skip the records that shifted into this page.
  const removeRecords = (ids: readonly string[]) => {
    const gone = new Set(ids);
    list.setData((current) =>
      current
        ? {
            items: current.items.filter((item) => !gone.has(item.id)),
            total: Math.max(0, current.total - gone.size),
          }
        : current,
    );
    setSelected((current) => withIdsSelected(current, ids, false));
  };

  const deleteOne = async (id: string) => {
    try {
      await api.deleteDictation(id);
      removeRecords([id]);
      list.reload();
      toast.success("Record deleted");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    try {
      await api.deleteDictations(ids);
      removeRecords(ids);
      list.reload();
      toast.success(`${ids.length} records deleted`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirm("none");
    }
  };

  const clearAll = async () => {
    try {
      await api.clearHistory();
      list.reload();
      setSelected(new Set());
      toast.success("History cleared");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirm("none");
    }
  };

  const allOnPageSelected = items.length > 0 && items.every((item) => selected.has(item.id));

  return (
    <div className="page">
      <Toolbar
        right={
          <>
            <a className="button-link" href={api.dictationExportUrl("json")} download>
              Export JSON
            </a>
            <a className="button-link" href={api.dictationExportUrl("csv")} download>
              Export CSV
            </a>
            <button type="button" className="danger" onClick={() => setConfirm("all")}>
              Clear all history
            </button>
          </>
        }
      >
        <h1 className="page-title">History</h1>
        {list.loading && <Spinner inline label="Loading…" />}
      </Toolbar>

      <Card>
        <div className="filters">
          <Labeled label="Search (raw + final)" wide>
            <input
              value={filters.q}
              placeholder="text fragment"
              onChange={(event) => update({ q: event.target.value })}
            />
          </Labeled>
          <Labeled label="Status">
            <select value={filters.status} onChange={(event) => update({ status: event.target.value })}>
              <option value="">any</option>
              {DictationStatusSchema.options.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="App (bundle id)">
            <input
              value={filters.bundleId}
              list="history-bundles"
              placeholder="com.apple.Terminal"
              onChange={(event) => update({ bundleId: event.target.value })}
            />
            <datalist id="history-bundles">
              {suggestions.bundles.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </Labeled>
          <Labeled label="Provider">
            <input
              value={filters.llmProvider}
              list="history-providers"
              placeholder="claude-cli"
              onChange={(event) => update({ llmProvider: event.target.value })}
            />
            <datalist id="history-providers">
              {suggestions.providers.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </Labeled>
          <Labeled label="Model">
            <input
              value={filters.llmModel}
              list="history-models"
              placeholder="haiku"
              onChange={(event) => update({ llmModel: event.target.value })}
            />
            <datalist id="history-models">
              {suggestions.models.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </Labeled>
          <Labeled label="From">
            <input
              type="datetime-local"
              value={filters.from}
              onChange={(event) => update({ from: event.target.value })}
            />
          </Labeled>
          <Labeled label="To">
            <input
              type="datetime-local"
              value={filters.to}
              onChange={(event) => update({ to: event.target.value })}
            />
          </Labeled>
          <button type="button" onClick={() => update(EMPTY_FILTERS)}>
            Reset filters
          </button>
        </div>
      </Card>

      {list.error !== undefined && (
        <div className="banner banner-fail">{errorMessage(list.error)}</div>
      )}

      <Card
        title={`${total} record${total === 1 ? "" : "s"}`}
        actions={
          <>
            <span className="muted small-text">{selected.size} selected</span>
            <button
              type="button"
              className="danger small"
              disabled={selected.size === 0}
              onClick={() => setConfirm("bulk")}
            >
              Delete selected
            </button>
          </>
        }
      >
        <div className="table-scroll">
          <table className="table history-table">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allOnPageSelected}
                    onChange={(event) =>
                      setSelected((current) =>
                        withIdsSelected(current, items.map((item) => item.id), event.target.checked),
                      )
                    }
                  />
                </th>
                <th>Time</th>
                <th>App</th>
                <th>Status</th>
                <th>Provider / model</th>
                <th className="num">STT</th>
                <th className="num">LLM</th>
                <th className="num">Total</th>
                <th>Text</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && !list.loading && (
                <tr>
                  <td colSpan={10} className="muted center">
                    No records match these filters.
                  </td>
                </tr>
              )}
              {items.map((record) => {
                const isExpanded = expanded.has(record.id);
                return (
                  <Fragment key={record.id}>
                    <tr className={isExpanded ? "expanded" : undefined}>
                      <td className="col-check">
                        <input
                          type="checkbox"
                          aria-label={`Select ${record.id}`}
                          checked={selected.has(record.id)}
                          onChange={() => setSelected((current) => toggle(current, record.id))}
                        />
                      </td>
                      <td className="nowrap">{formatDateTimeShort(record.createdAt)}</td>
                      <td>{record.appName ?? record.bundleId ?? EM_DASH}</td>
                      <td>
                        <StatusPill tone={dictationStatusTone(record.status)}>{record.status}</StatusPill>
                      </td>
                      <td className="small-text">
                        {record.llmProvider ?? EM_DASH}
                        <div className="mono">{record.llmModel ?? EM_DASH}</div>
                      </td>
                      <td className="num">{formatMs(record.sttLatencyMs)}</td>
                      <td className="num">{formatMs(record.llmLatencyMs)}</td>
                      <td className="num">{formatMs(record.totalLatencyMs)}</td>
                      <td className="cell-text">
                        {record.finalText ?? record.rawTranscript ?? EM_DASH}
                        {record.audioPath && (
                          <span className="audio-flag" title="Audio stored for this record">
                            ♪
                          </span>
                        )}
                      </td>
                      <td className="col-actions">
                        <button
                          type="button"
                          className="small"
                          onClick={() => setExpanded((current) => toggle(current, record.id))}
                        >
                          {isExpanded ? "Close" : "Open"}
                        </button>
                        <CopyButton value={record.rawTranscript} label="Raw" title="Copy raw transcript" />
                        <CopyButton value={record.finalText} label="Final" title="Copy final text" />
                        <button
                          type="button"
                          className="small danger"
                          onClick={() => setConfirm({ id: record.id })}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="detail-row">
                        <td colSpan={10}>
                          <RecordDetail
                            record={record}
                            capabilities={capabilities.data}
                            onChanged={replaceRecord}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            ← Newer
          </button>
          <span className="muted">
            {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`} of {total}
          </span>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Older →
          </button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirm === "bulk"}
        title="Delete selected records"
        message={`${selected.size} records will be deleted permanently.`}
        confirmLabel="Delete"
        danger
        onConfirm={deleteSelected}
        onCancel={() => setConfirm("none")}
      />
      <ConfirmDialog
        open={confirm === "all"}
        title="Clear all history"
        message="Every dictation record and its stored audio reference will be removed. This cannot be undone."
        confirmLabel="Clear everything"
        requirePhrase="delete"
        danger
        onConfirm={clearAll}
        onCancel={() => setConfirm("none")}
      />
      <ConfirmDialog
        open={typeof confirm === "object"}
        title="Delete record"
        message="This record will be deleted permanently."
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (typeof confirm === "object") await deleteOne(confirm.id);
          setConfirm("none");
        }}
        onCancel={() => setConfirm("none")}
      />
    </div>
  );
}
