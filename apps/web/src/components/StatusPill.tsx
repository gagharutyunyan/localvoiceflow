import type { ReactNode } from "react";
import type { PermissionState } from "@lvf/shared";

export type PillTone = "ok" | "warn" | "fail" | "info" | "neutral";

export interface StatusPillProps {
  tone: PillTone;
  children: ReactNode;
  title?: string;
}

export function StatusPill({ tone, children, title }: StatusPillProps) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function permissionTone(state: PermissionState | undefined): PillTone {
  switch (state) {
    case "granted":
      return "ok";
    case "denied":
      return "fail";
    case "not-determined":
      return "warn";
    default:
      return "neutral";
  }
}

export function permissionLabel(state: PermissionState | undefined): string {
  switch (state) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    case "not-determined":
      return "not requested";
    default:
      return "unknown";
  }
}

export function dictationStatusTone(status: string | undefined): PillTone {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
      return "fail";
    case "cancelled":
      return "neutral";
    case "recording":
    case "transcribing":
    case "correcting":
      return "info";
    default:
      return "neutral";
  }
}

export function healthTone(state: string | undefined): PillTone {
  switch (state) {
    case "ok":
    case "ready":
      return "ok";
    case "degraded":
    case "loading":
    case "starting":
      return "warn";
    case "error":
    case "stopped":
      return "fail";
    default:
      return "neutral";
  }
}
