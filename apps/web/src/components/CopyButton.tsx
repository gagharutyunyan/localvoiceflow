import { useCallback, useRef, useState } from "react";

export interface CopyButtonProps {
  value: string | undefined;
  label?: string;
  title?: string;
  small?: boolean;
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Safari denies the async clipboard API on some non-secure origins; 127.0.0.1 is
  // treated as secure, but the fallback keeps copy working if it is ever refused.
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("Clipboard write was refused by the browser");
}

export function CopyButton({ value, label = "Copy", title, small = true }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  const timer = useRef<number | undefined>(undefined);

  const copy = useCallback(async () => {
    if (!value) return;
    try {
      await writeClipboard(value);
      setState("done");
    } catch {
      setState("error");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  }, [value]);

  return (
    <button
      type="button"
      className={small ? "small" : undefined}
      onClick={() => void copy()}
      disabled={!value}
      title={title ?? label}
    >
      {state === "done" ? "Copied" : state === "error" ? "Failed" : label}
    </button>
  );
}
