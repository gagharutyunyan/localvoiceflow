import { useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAsync, usePolling } from "../api/hooks";
import { CopyButton } from "../components/CopyButton";
import { DoctorReport } from "../components/DoctorReport";
import { Spinner } from "../components/Spinner";
import { StatusPill } from "../components/StatusPill";
import { Toolbar } from "../components/Toolbar";
import { useToast } from "../components/Toast";
import { formatMs } from "../lib/format";

export function Diagnostics() {
  const toast = useToast();
  const report = useAsync((signal) => api.diagnostics(signal), []);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [testing, setTesting] = useState(false);

  usePolling(report.reload, 15_000, autoRefresh);

  const runTranscriptionTest = async () => {
    setTesting(true);
    try {
      const result = await api.testTranscription();
      const text = result.transcript ?? result.text ?? "";
      toast.success(
        `STT fixture: ${formatMs(result.latencyMs ?? result.transcriptionMs)} — "${text.slice(0, 80)}"`,
      );
      report.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="page">
      <Toolbar
        right={
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
              />
              <span>Auto-refresh</span>
            </label>
            <button type="button" onClick={() => void runTranscriptionTest()} disabled={testing}>
              {testing ? <Spinner inline label="Transcribing…" /> : "Test transcription"}
            </button>
            <CopyButton
              value={report.data ? JSON.stringify(report.data, null, 2) : undefined}
              label="Copy report"
              small={false}
            />
            <button type="button" onClick={report.reload} disabled={report.loading}>
              Refresh
            </button>
          </>
        }
      >
        <h1 className="page-title">Diagnostics</h1>
        {report.loading && <Spinner inline label="Collecting…" />}
        {!report.loading && report.data && <StatusPill tone="neutral">GET /api/diagnostics</StatusPill>}
      </Toolbar>

      {report.error !== undefined && (
        <div className="banner banner-fail">
          <strong>Could not read diagnostics.</strong> {errorMessage(report.error)}
        </div>
      )}

      {report.data && <DoctorReport report={report.data} />}
    </div>
  );
}
