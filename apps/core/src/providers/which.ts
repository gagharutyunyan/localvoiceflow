import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Resolves a command to an absolute path.
 *
 * launchd hands a background process a minimal PATH, so the directories where these
 * CLIs actually live on a developer Mac are searched explicitly. Only a fixed set of
 * command names is ever resolved — an executable path is never accepted from a client.
 */
const EXTRA_SEARCH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  `${process.env.HOME ?? ""}/.local/bin`,
  `${process.env.HOME ?? ""}/.bun/bin`,
  `${process.env.HOME ?? ""}/.cargo/bin`,
  `${process.env.HOME ?? ""}/.npm-global/bin`,
  `${process.env.HOME ?? ""}/.claude/local`,
];

const ALLOWED_COMMANDS = new Set(["claude", "codex", "node", "python3", "say", "ffmpeg"]);

const cache = new Map<string, string | undefined>();

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutable(
  command: string,
  options: { refresh?: boolean } = {},
): Promise<string | undefined> {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`refusing to resolve unlisted command: ${command}`);
  }
  if (!options.refresh && cache.has(command)) return cache.get(command);

  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  const seen = new Set<string>();
  const dirs = [...pathDirs, ...EXTRA_SEARCH_DIRS].filter((dir) => {
    if (dir.length === 0 || !isAbsolute(dir) || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });

  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (await isExecutable(candidate)) {
      cache.set(command, candidate);
      return candidate;
    }
  }

  cache.set(command, undefined);
  return undefined;
}

export function clearExecutableCache(): void {
  cache.clear();
}
