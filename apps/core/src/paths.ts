import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { APP_NAME } from "@lvf/shared";

/**
 * Every path the app writes to. Nothing is ever written inside the repository —
 * user data lives under the standard macOS Application Support / Logs locations.
 */
export interface AppPaths {
  dataDir: string;
  audioDir: string;
  tmpDir: string;
  logsDir: string;
  dbFile: string;
  tokenFile: string;
  /** Empty working directory handed to the LLM CLIs so they cannot see the user's project. */
  cliWorkDir: string;
}

export function resolvePaths(overrides: Partial<AppPaths> = {}): AppPaths {
  const home = homedir();
  const dataDir = overrides.dataDir ?? join(home, "Library", "Application Support", APP_NAME);
  const logsDir = overrides.logsDir ?? join(home, "Library", "Logs", APP_NAME);

  return {
    dataDir,
    logsDir,
    audioDir: overrides.audioDir ?? join(dataDir, "audio"),
    tmpDir: overrides.tmpDir ?? join(dataDir, "tmp"),
    dbFile: overrides.dbFile ?? join(dataDir, "local-voice-flow.sqlite"),
    tokenFile: overrides.tokenFile ?? join(dataDir, "token"),
    cliWorkDir: overrides.cliWorkDir ?? join(dataDir, "cli-workdir"),
  };
}

export function ensureDirectories(paths: AppPaths): void {
  for (const dir of [paths.dataDir, paths.logsDir, paths.audioDir, paths.tmpDir, paths.cliWorkDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Repository root, derived from this file's location at runtime. */
export function repoRoot(importMetaUrl: string): string {
  const here = new URL(".", importMetaUrl).pathname;
  // dist/ or src/ -> apps/core -> apps -> repo root
  return join(here, "..", "..", "..");
}
