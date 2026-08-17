import { z } from "zod";
import { FormattingProfileSchema, type FormattingProfile } from "./settings.js";

export const AppProfileSchema = z.object({
  bundleId: z.string().trim().min(1).max(200),
  appName: z.string().trim().max(200).optional(),
  profile: FormattingProfileSchema,
  /** Seeded rules can be edited but are re-created on a fresh database. */
  builtin: z.boolean().default(false),
});

export type AppProfile = z.infer<typeof AppProfileSchema>;

/**
 * Bundle identifiers mapped to the Developer profile out of the box. Everything not
 * listed falls back to the user's default profile (Smart unless changed).
 */
export const BUILTIN_APP_PROFILES: readonly Omit<AppProfile, "builtin">[] = [
  { bundleId: "com.jetbrains.WebStorm", appName: "WebStorm", profile: "developer" },
  { bundleId: "com.jetbrains.intellij", appName: "IntelliJ IDEA", profile: "developer" },
  { bundleId: "com.jetbrains.intellij.ce", appName: "IntelliJ IDEA CE", profile: "developer" },
  { bundleId: "com.jetbrains.pycharm", appName: "PyCharm", profile: "developer" },
  { bundleId: "com.jetbrains.rider", appName: "Rider", profile: "developer" },
  { bundleId: "com.jetbrains.goland", appName: "GoLand", profile: "developer" },
  { bundleId: "com.jetbrains.PhpStorm", appName: "PhpStorm", profile: "developer" },
  { bundleId: "com.microsoft.VSCode", appName: "Visual Studio Code", profile: "developer" },
  { bundleId: "com.todesktop.230313mzl4w4u92", appName: "Cursor", profile: "developer" },
  { bundleId: "com.apple.Terminal", appName: "Terminal", profile: "developer" },
  { bundleId: "com.googlecode.iterm2", appName: "iTerm2", profile: "developer" },
  { bundleId: "dev.warp.Warp-Stable", appName: "Warp", profile: "developer" },
  { bundleId: "com.github.wez.wezterm", appName: "WezTerm", profile: "developer" },
  { bundleId: "net.kovidgoyal.kitty", appName: "kitty", profile: "developer" },
  { bundleId: "com.apple.dt.Xcode", appName: "Xcode", profile: "developer" },

  { bundleId: "ru.keepcoder.Telegram", appName: "Telegram", profile: "smart" },
  { bundleId: "com.tinyspeck.slackmacgap", appName: "Slack", profile: "smart" },
  { bundleId: "com.apple.mail", appName: "Mail", profile: "smart" },
  { bundleId: "com.apple.MobileSMS", appName: "Messages", profile: "smart" },
  { bundleId: "com.hnc.Discord", appName: "Discord", profile: "smart" },
  { bundleId: "us.zoom.xos", appName: "Zoom", profile: "smart" },
  { bundleId: "com.apple.Notes", appName: "Notes", profile: "smart" },
  { bundleId: "com.apple.TextEdit", appName: "TextEdit", profile: "smart" },
];

/**
 * Resolves the formatting profile for a target application.
 * An explicit user rule always wins over the built-in table.
 */
export function resolveProfile(
  bundleId: string | undefined,
  rules: readonly AppProfile[],
  defaultProfile: FormattingProfile,
): FormattingProfile {
  if (!bundleId) return defaultProfile;
  const match = rules.find((rule) => rule.bundleId === bundleId);
  return match?.profile ?? defaultProfile;
}
