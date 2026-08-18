import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/**
 * Walks up from this file to the repository root (marked by pnpm-workspace.yaml).
 * Works both from `src/` (tsx/strip-types) and from `dist/` after a build.
 */
export function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Installed layout: the app bundle keeps prompts/ next to the built core.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
