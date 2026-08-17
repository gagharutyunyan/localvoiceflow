import type { ReactNode } from "react";
import type { CheckLevel, DiagnosticCheck, DiagnosticsReport } from "../api/types";
import { Card, FieldRow } from "./Card";
import { StatusPill, permissionLabel, permissionTone } from "./StatusPill";
import { EM_DASH, formatDuration, formatDateTime, formatMs } from "../lib/format";

const LEVEL_TONE: Record<CheckLevel, "ok" | "warn" | "fail"> = {
  ok: "ok",
  warn: "warn",
  fail: "fail",
};

const PERMISSION_ACTIONS: Record<string, string> = {
  microphone: "Open System Settings → Privacy & Security → Microphone and enable LocalVoiceFlow.",
  accessibility:
    "Open System Settings → Privacy & Security → Accessibility and enable LocalVoiceFlow.",
  inputMonitoring:
    "Open System Settings → Privacy & Security → Input Monitoring and enable LocalVoiceFlow.",
};

const PROVIDER_LOGIN_HINT: Record<string, string> = {
  "claude-cli": "Run `claude auth status` in a terminal and sign in with your Claude subscription.",
  "openai-codex-cli": "Run `codex login status` in a terminal and sign in with your ChatGPT account.",
};

function permissionCheck(
  key: "microphone" | "accessibility" | "inputMonitoring",
  label: string,
  state: string | undefined,
): DiagnosticCheck {
  const level: CheckLevel = state === "granted" ? "ok" : state === "denied" ? "fail" : "warn";
  const check: DiagnosticCheck = {
    id: `permission-${key}`,
    label,
    level,
    detail: state ?? "unknown",
  };
  if (level !== "ok") check.action = PERMISSION_ACTIONS[key] ?? "";
  return check;
}

/**
 * Derives doctor rows from the structured payload. Core may send its own `checks`
 * array, in which case that one is authoritative and this is not used.
 */
export function deriveChecks(report: DiagnosticsReport): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];

  checks.push({
    id: "core",
    label: "Core service",
    level: "ok",
    detail: `${report.app?.name ?? "LocalVoiceFlow"} ${report.app?.version ?? ""} on port ${
      report.core?.port ?? report.app?.port ?? EM_DASH
    }`.trim(),
  });

  if (report.core?.sqliteWritable === false) {
    checks.push({
      id: "sqlite",
      label: "Database is writable",
      level: "fail",
      detail: report.core.databasePath ?? "SQLite database cannot be written",
      action:
        "Check the permissions of ~/Library/Application Support/LocalVoiceFlow and that the disk is not full.",
    });
  } else if (report.core?.sqliteWritable === true) {
    checks.push({ id: "sqlite", label: "Database is writable", level: "ok" });
  }

  const stt = report.stt;
  if (stt) {
    const level: CheckLevel = stt.ready
      ? "ok"
      : stt.state === "error" || stt.state === "stopped"
        ? "fail"
        : "warn";
    const check: DiagnosticCheck = {
      id: "stt",
      label: "Speech-to-text worker",
      level,
      detail: [stt.state, stt.model, stt.device, stt.error].filter(Boolean).join(" · "),
    };
    if (level === "fail") {
      check.action =
        "Run scripts/bootstrap.sh to rebuild the Python environment, then check the worker log in the logs directory.";
    } else if (level === "warn") {
      check.action = "The model is still loading; the first dictation will wait for it.";
    }
    checks.push(check);
  }

  const permissions = report.permissions;
  if (permissions) {
    checks.push(permissionCheck("microphone", "Microphone permission", permissions.microphone));
    checks.push(
      permissionCheck("accessibility", "Accessibility permission", permissions.accessibility),
    );
    checks.push(
      permissionCheck("inputMonitoring", "Input Monitoring permission", permissions.inputMonitoring),
    );
    checks.push({
      id: "agent",
      label: "macOS agent connected",
      level: permissions.agentConnected ? "ok" : "warn",
      detail: permissions.reportedAt ? `last report ${formatDateTime(permissions.reportedAt)}` : "",
      ...(permissions.agentConnected
        ? {}
        : { action: "Launch LocalVoiceFlow.app — the menu-bar agent reports permissions and captures audio." }),
    });
    if (permissions.fnTapActive === false) {
      checks.push({
        id: "fn-tap",
        label: "Fn key event tap",
        level: "warn",
        detail: permissions.fnTapError ?? "the Fn tap could not be installed",
        action:
          "Grant Input Monitoring, then restart the agent. The fallback hotkey keeps working meanwhile.",
      });
    }
  }

  for (const provider of report.providers ?? []) {
    if (!provider.available) {
      checks.push({
        id: `provider-${provider.id}-cli`,
        label: `${provider.id}: CLI available`,
        level: "fail",
        detail: provider.error ?? "the CLI was not found on PATH",
        action: "Install the CLI and make sure its directory is on PATH for the core process.",
      });
      continue;
    }
    checks.push({
      id: `provider-${provider.id}-cli`,
      label: `${provider.id}: CLI available`,
      level: "ok",
      detail: [provider.cliPath, provider.version].filter(Boolean).join(" · "),
    });
    checks.push({
      id: `provider-${provider.id}-auth`,
      label: `${provider.id}: authenticated`,
      level: provider.authenticated ? "ok" : "fail",
      detail: provider.authDetail ?? "",
      ...(provider.authenticated
        ? {}
        : { action: PROVIDER_LOGIN_HINT[provider.id] ?? "Sign in with the provider's CLI." }),
    });
    if (provider.missingFlags.length > 0) {
      checks.push({
        id: `provider-${provider.id}-flags`,
        label: `${provider.id}: unsupported flags`,
        level: "warn",
        detail: provider.missingFlags.join(", "),
        action: "Update the CLI; core falls back to a reduced command line without these flags.",
      });
    }
  }

  if (report.lastError) {
    checks.push({
      id: "last-error",
      label: "Last error",
      level: "warn",
      detail: `${report.lastError.code}: ${report.lastError.message} (${formatDateTime(report.lastError.at)})`,
      action: "Reproduce with Test recording or Test model to see whether it still happens.",
    });
  }

  return checks;
}

function CheckRow({ check }: { check: DiagnosticCheck }) {
  return (
    <li className={`check check-${check.level}`}>
      <StatusPill tone={LEVEL_TONE[check.level] ?? "neutral"}>{check.level.toUpperCase()}</StatusPill>
      <div className="check-text">
        <div className="check-label">{check.label}</div>
        {check.detail && <div className="check-detail">{check.detail}</div>}
        {check.action && <div className="check-action">→ {check.action}</div>}
      </div>
    </li>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <>{children === undefined || children === null || children === "" ? EM_DASH : children}</>;
}

export interface DoctorReportProps {
  report: DiagnosticsReport;
  compact?: boolean;
}

export function DoctorReport({ report, compact = false }: DoctorReportProps) {
  const checks = report.checks && report.checks.length > 0 ? report.checks : deriveChecks(report);
  const failures = checks.filter((check) => check.level === "fail").length;
  const warnings = checks.filter((check) => check.level === "warn").length;

  const envNames = new Set<string>(report.apiKeyEnvPresent ?? []);
  for (const provider of report.providers ?? []) {
    for (const name of provider.apiKeyEnvPresent ?? []) envNames.add(name);
  }

  return (
    <div className="doctor">
      <Card
        title="Doctor"
        subtitle={
          <>
            {checks.length} checks · {failures} failed · {warnings} warnings
            {report.generatedAt ? ` · ${formatDateTime(report.generatedAt)}` : ""}
          </>
        }
      >
        <ul className="check-list">
          {checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      </Card>

      {!compact && (
        <>
          <Card title="Environment">
            <FieldRow label="macOS">
              <Value>
                {[report.system?.macosVersion, report.system?.build].filter(Boolean).join(" ")}
              </Value>
            </FieldRow>
            <FieldRow label="Architecture">
              <Value>{[report.system?.arch, report.system?.cpu].filter(Boolean).join(" · ")}</Value>
            </FieldRow>
            <FieldRow label="Node">
              <Value>{report.system?.node}</Value>
            </FieldRow>
            <FieldRow label="Python">
              <Value>{report.system?.python}</Value>
            </FieldRow>
            <FieldRow label="ffmpeg">
              <Value>{report.system?.ffmpeg}</Value>
            </FieldRow>
            <FieldRow label="App version">
              <Value>{report.app?.version}</Value>
            </FieldRow>
            <FieldRow label="Port">
              <Value>{report.core?.port ?? report.app?.port}</Value>
            </FieldRow>
            <FieldRow label="Uptime">
              <Value>{formatDuration(report.core?.uptimeMs)}</Value>
            </FieldRow>
            <FieldRow label="Data directory">
              <Value>{report.core?.dataDirectory}</Value>
            </FieldRow>
            <FieldRow label="Logs directory">
              <Value>{report.core?.logsDirectory}</Value>
            </FieldRow>
          </Card>

          <Card title="Speech-to-text">
            <FieldRow label="Backend">
              <Value>{report.stt?.backend}</Value>
            </FieldRow>
            <FieldRow label="State">
              <Value>{report.stt?.state}</Value>
            </FieldRow>
            <FieldRow label="Model">
              <Value>{report.stt?.model}</Value>
            </FieldRow>
            <FieldRow label="Device">
              <Value>{report.stt?.device}</Value>
            </FieldRow>
            <FieldRow label="Model load time">
              <Value>{report.stt?.loadMs === undefined ? undefined : formatMs(report.stt.loadMs)}</Value>
            </FieldRow>
            <FieldRow label="Worker restarts">
              <Value>{report.stt?.restarts ?? 0}</Value>
            </FieldRow>
            <FieldRow label="Python">
              <Value>{report.stt?.pythonPath}</Value>
            </FieldRow>
          </Card>

          <Card title="Providers">
            {(report.providers ?? []).length === 0 ? (
              <p className="muted">Core reported no provider health.</p>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>CLI</th>
                      <th>Version</th>
                      <th>Auth</th>
                      <th>Unsupported flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.providers ?? []).map((provider) => (
                      <tr key={provider.id}>
                        <td>{provider.id}</td>
                        <td>
                          <StatusPill tone={provider.available ? "ok" : "fail"}>
                            {provider.available ? "found" : "missing"}
                          </StatusPill>
                          <div className="mono small-text">{provider.cliPath ?? EM_DASH}</div>
                        </td>
                        <td>{provider.version ?? EM_DASH}</td>
                        <td>
                          <StatusPill tone={provider.authenticated ? "ok" : "fail"}>
                            {provider.authenticated ? "signed in" : "signed out"}
                          </StatusPill>
                          <div className="small-text">{provider.authDetail ?? ""}</div>
                        </td>
                        <td>{provider.missingFlags.length > 0 ? provider.missingFlags.join(", ") : EM_DASH}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="API key environment variables"
            subtitle="Names only — LocalVoiceFlow never reads or displays the values."
          >
            {envNames.size === 0 ? (
              <p className="muted">No API-key variables are set in the core process (subscription auth is used).</p>
            ) : (
              <ul className="plain-list">
                {[...envNames].sort().map((name) => (
                  <li key={name}>
                    <code>{name}</code> <span className="muted">is set (value not read)</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Permissions">
            {(["microphone", "accessibility", "inputMonitoring"] as const).map((key) => (
              <FieldRow key={key} label={key === "inputMonitoring" ? "Input Monitoring" : key}>
                <StatusPill tone={permissionTone(report.permissions?.[key])}>
                  {permissionLabel(report.permissions?.[key])}
                </StatusPill>
              </FieldRow>
            ))}
            <FieldRow label="Agent">
              <StatusPill tone={report.permissions?.agentConnected ? "ok" : "warn"}>
                {report.permissions?.agentConnected ? "connected" : "not connected"}
              </StatusPill>
            </FieldRow>
          </Card>

          <Card title="Active correction settings">
            <FieldRow label="Provider">
              <Value>{report.correction?.provider}</Value>
            </FieldRow>
            <FieldRow label="Model">
              <Value>{report.correction?.model}</Value>
            </FieldRow>
            <FieldRow label="Effort">
              <Value>{report.correction?.effort}</Value>
            </FieldRow>
            <FieldRow label="Profile">
              <Value>{report.correction?.profile}</Value>
            </FieldRow>
          </Card>
        </>
      )}
    </div>
  );
}
