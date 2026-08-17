import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import type { ServerEvent } from "@lvf/shared";
import { api, errorMessage } from "../api/client";
import { useAsync, usePolling, useSSE } from "../api/hooks";
import type { DiagnosticsReport, TestTranscriptionResult } from "../api/types";
import { Card, FieldRow } from "../components/Card";
import { CopyButton } from "../components/CopyButton";
import { DoctorReport } from "../components/DoctorReport";
import { Spinner } from "../components/Spinner";
import {
  StatusPill,
  dictationStatusTone,
  healthTone,
  permissionLabel,
  permissionTone,
} from "../components/StatusPill";
import { Toolbar } from "../components/Toolbar";
import { useToast } from "../components/Toast";
import { EM_DASH, formatDateTime, formatDuration, formatMs, truncate } from "../lib/format";

interface LiveStage {
  dictationId: string;
  stage: string;
  at: string;
}

export function Dashboard() {
  const toast = useToast();
  const status = useAsync((signal) => api.status(signal), []);
  const [liveStage, setLiveStage] = useState<LiveStage | undefined>(undefined);
  const [testResult, setTestResult] = useState<TestTranscriptionResult | undefined>(undefined);
  const [testing, setTesting] = useState(false);
  const [doctor, setDoctor] = useState<DiagnosticsReport | undefined>(undefined);
  const [doctorLoading, setDoctorLoading] = useState(false);

  const { reload, setData } = status;

  const onEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "pipeline": {
          setLiveStage({ dictationId: event.dictationId, stage: event.stage, at: event.at });
          if (event.stage === "completed" || event.stage === "failed" || event.stage === "cancelled") {
            reload();
          }
          break;
        }
        case "stt-status": {
          setData((current) =>
            current
              ? {
                  ...current,
                  stt: {
                    ...current.stt,
                    ready: event.ready,
                    state: event.state,
                    model: event.model ?? current.stt.model,
                    error: event.error,
                  },
                }
              : current,
          );
          break;
        }
        case "settings-changed": {
          reload();
          break;
        }
        default:
          break;
      }
    },
    [reload, setData],
  );

  const { connected } = useSSE("/api/events", onEvent);
  // The SSE stream is the live path; polling only covers the window where it is down.
  usePolling(reload, 5000, !connected);

  const lastId = status.data?.lastDictation?.id;
  const lastRecord = useAsync(
    (signal) => (lastId ? api.getDictation(lastId, signal) : Promise.resolve(undefined)),
    [lastId],
  );

  const runTestRecording = async () => {
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await api.testTranscription();
      setTestResult(result);
      toast.success("Test transcription finished");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  const runDoctor = async () => {
    setDoctorLoading(true);
    try {
      setDoctor(await api.diagnostics());
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDoctorLoading(false);
    }
  };

  const unreachable = status.error !== undefined && status.data === undefined;
  const data = status.data;
  const permissions = data?.permissions;

  return (
    <div className="page">
      <Toolbar
        right={
          <>
            <StatusPill tone={connected ? "ok" : "warn"} title="Server-sent events stream">
              {connected ? "live" : "reconnecting"}
            </StatusPill>
            <button type="button" onClick={reload} disabled={status.loading}>
              Refresh
            </button>
          </>
        }
      >
        <h1 className="page-title">Dashboard</h1>
        {status.loading && <Spinner inline label="Loading status…" />}
      </Toolbar>

      {unreachable && (
        <div className="banner banner-fail">
          <strong>Service unreachable.</strong> {errorMessage(status.error)}
        </div>
      )}

      <div className="grid">
        <Card
          title="Service"
          actions={
            <StatusPill tone={unreachable ? "fail" : healthTone(data?.state)}>
              {unreachable ? "stopped" : `running · ${data?.state ?? "unknown"}`}
            </StatusPill>
          }
        >
          <FieldRow label="Version">{data?.version ?? EM_DASH}</FieldRow>
          <FieldRow label="Port">{data?.port ?? EM_DASH}</FieldRow>
          <FieldRow label="Uptime">{formatDuration(data?.uptimeMs)}</FieldRow>
          <FieldRow label="Live pipeline">
            {liveStage ? (
              <>
                <StatusPill tone="info">{liveStage.stage}</StatusPill>{" "}
                <span className="mono small-text">{liveStage.dictationId}</span>
              </>
            ) : (
              <span className="muted">idle</span>
            )}
          </FieldRow>
          {data?.lastError && (
            <FieldRow label="Last error">
              <span className="error-text">
                {data.lastError.code}: {data.lastError.message}
              </span>
              <div className="small-text muted">{formatDateTime(data.lastError.at)}</div>
            </FieldRow>
          )}
        </Card>

        <Card
          title="Permissions"
          subtitle="Reported by the macOS agent"
          actions={
            <StatusPill tone={permissions?.agentConnected ? "ok" : "warn"}>
              {permissions?.agentConnected ? "agent connected" : "agent offline"}
            </StatusPill>
          }
        >
          <FieldRow label="Microphone">
            <StatusPill tone={permissionTone(permissions?.microphone)}>
              {permissionLabel(permissions?.microphone)}
            </StatusPill>
          </FieldRow>
          <FieldRow label="Accessibility">
            <StatusPill tone={permissionTone(permissions?.accessibility)}>
              {permissionLabel(permissions?.accessibility)}
            </StatusPill>
          </FieldRow>
          <FieldRow label="Input Monitoring">
            <StatusPill tone={permissionTone(permissions?.inputMonitoring)}>
              {permissionLabel(permissions?.inputMonitoring)}
            </StatusPill>
          </FieldRow>
          <FieldRow label="Reported">
            {permissions?.reportedAt ? formatDateTime(permissions.reportedAt) : EM_DASH}
          </FieldRow>
        </Card>

        <Card
          title="Speech-to-text"
          actions={
            <StatusPill tone={data?.stt.ready ? "ok" : healthTone(data?.stt.state)}>
              {data?.stt.ready ? "ready" : (data?.stt.state ?? "unknown")}
            </StatusPill>
          }
        >
          <FieldRow label="Backend">{data?.stt.backend ?? EM_DASH}</FieldRow>
          <FieldRow label="Model">
            <span className="mono">{data?.stt.model ?? EM_DASH}</span>
          </FieldRow>
          <FieldRow label="Device">{data?.stt.device ?? EM_DASH}</FieldRow>
          <FieldRow label="Model load">{formatMs(data?.stt.loadMs)}</FieldRow>
          <FieldRow label="Worker restarts">{data?.stt.restarts ?? 0}</FieldRow>
          {data?.stt.error && (
            <FieldRow label="Error">
              <span className="error-text">{data.stt.error}</span>
            </FieldRow>
          )}
        </Card>

        <Card title="Text correction">
          <FieldRow label="Provider">{data?.correction.provider ?? EM_DASH}</FieldRow>
          <FieldRow label="Model">
            <span className="mono">{data?.correction.model ?? EM_DASH}</span>
          </FieldRow>
          <FieldRow label="Effort">{data?.correction.effort ?? EM_DASH}</FieldRow>
          <FieldRow label="Profile">{data?.correction.profile ?? EM_DASH}</FieldRow>
          <div className="row-actions">
            <Link className="button-link" to="/settings">
              Change
            </Link>
          </div>
        </Card>

        <Card
          title="Last dictation"
          className="span-2"
          actions={
            data?.lastDictation ? (
              <StatusPill tone={dictationStatusTone(data.lastDictation.status)}>
                {data.lastDictation.status}
              </StatusPill>
            ) : undefined
          }
        >
          {!data?.lastDictation ? (
            <p className="muted">Nothing dictated yet.</p>
          ) : (
            <>
              <div className="latency-row">
                <div className="latency">
                  <span className="latency-label">STT</span>
                  <span className="latency-value">{formatMs(data.lastDictation.sttLatencyMs)}</span>
                </div>
                <div className="latency">
                  <span className="latency-label">LLM</span>
                  <span className="latency-value">{formatMs(data.lastDictation.llmLatencyMs)}</span>
                </div>
                <div className="latency">
                  <span className="latency-label">Total</span>
                  <span className="latency-value">{formatMs(data.lastDictation.totalLatencyMs)}</span>
                </div>
              </div>
              <FieldRow label="When">{formatDateTime(data.lastDictation.createdAt)}</FieldRow>
              <FieldRow label="Id">
                <span className="mono small-text">{data.lastDictation.id}</span>
              </FieldRow>
              {lastRecord.data && (
                <>
                  <FieldRow label="App">
                    {lastRecord.data.appName ?? lastRecord.data.bundleId ?? EM_DASH}
                  </FieldRow>
                  <FieldRow label="Text">
                    <div className="text-block">
                      {lastRecord.data.finalText ?? lastRecord.data.rawTranscript ?? EM_DASH}
                    </div>
                    <div className="row-actions">
                      <CopyButton value={lastRecord.data.finalText} label="Copy final" />
                      <CopyButton value={lastRecord.data.rawTranscript} label="Copy raw" />
                      <Link className="button-link small" to="/history">
                        Open in history
                      </Link>
                    </div>
                  </FieldRow>
                </>
              )}
            </>
          )}
        </Card>

        <Card title="Actions" className="span-2">
          <div className="button-row">
            <button type="button" className="primary" onClick={() => void runTestRecording()} disabled={testing}>
              {testing ? <Spinner inline label="Transcribing fixture…" /> : "Test recording"}
            </button>
            <button type="button" onClick={() => void runDoctor()} disabled={doctorLoading}>
              {doctorLoading ? <Spinner inline label="Running doctor…" /> : "Run doctor"}
            </button>
            <Link className="button-link" to="/history">
              Open history
            </Link>
            <Link className="button-link" to="/dictionary">
              Open dictionary
            </Link>
            <Link className="button-link" to="/settings">
              Open settings
            </Link>
          </div>

          {testResult && (
            <div className="result-block">
              <FieldRow label="Transcript">
                <div className="text-block">
                  {truncate(testResult.transcript ?? testResult.text ?? "", 2000) || EM_DASH}
                </div>
              </FieldRow>
              <FieldRow label="Latency">
                {formatMs(testResult.latencyMs ?? testResult.transcriptionMs)}
              </FieldRow>
              <FieldRow label="Audio duration">{formatMs(testResult.audioDurationMs)}</FieldRow>
              <FieldRow label="Model">
                <span className="mono">{testResult.model ?? EM_DASH}</span>
              </FieldRow>
              {testResult.error && (
                <FieldRow label="Error">
                  <span className="error-text">{testResult.error}</span>
                </FieldRow>
              )}
            </div>
          )}
        </Card>
      </div>

      {doctor && (
        <div className="doctor-inline">
          <DoctorReport report={doctor} compact />
          <p className="muted">
            <Link to="/diagnostics">Open the full diagnostics report →</Link>
          </p>
        </div>
      )}
    </div>
  );
}
