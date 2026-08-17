import { useCallback, useEffect, useRef, useState } from "react";
import type { DependencyList, Dispatch, SetStateAction } from "react";
import type { ServerEvent } from "@lvf/shared";

export interface AsyncResult<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: Dispatch<SetStateAction<T | undefined>>;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Runs an async loader whenever `deps` change, aborting the in-flight request first
 * so a slow response can never overwrite a newer one.
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): AsyncResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);

    loaderRef.current(controller.signal).then(
      (value) => {
        if (!active) return;
        setData(value);
        setError(undefined);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active || isAbort(cause)) return;
        setError(cause);
        setLoading(false);
      },
    );

    return () => {
      active = false;
      controller.abort();
    };
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, error, loading, reload, setData };
}

/** Calls `callback` every `intervalMs`, but never while the tab is hidden. */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    const fire = () => {
      if (!document.hidden) callbackRef.current();
    };
    const timer = window.setInterval(fire, intervalMs);
    document.addEventListener("visibilitychange", fire);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", fire);
    };
  }, [intervalMs, enabled]);
}

export interface SseState {
  connected: boolean;
  lastEventAt: number | undefined;
}

/**
 * Core may emit SSE frames either unnamed (`data:` only) or with an `event:` name
 * matching `ServerEvent.type`; both are subscribed, and a frame only ever reaches
 * one of them, so no event is handled twice.
 */
const SSE_EVENT_NAMES = ["hello", "pipeline", "stt-status", "settings-changed"] as const;

export function useSSE(
  path: string,
  onEvent: (event: ServerEvent) => void,
  enabled = true,
): SseState {
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | undefined>(undefined);

  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }

    // Same-origin EventSource carries the HttpOnly session cookie automatically.
    const source = new EventSource(path);

    const dispatch = (event: Event) => {
      const message = event as MessageEvent<unknown>;
      if (typeof message.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      if (typeof (parsed as { type?: unknown }).type !== "string") return;
      setConnected(true);
      setLastEventAt(Date.now());
      handlerRef.current(parsed as ServerEvent);
    };

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = dispatch;
    for (const name of SSE_EVENT_NAMES) source.addEventListener(name, dispatch);

    return () => {
      for (const name of SSE_EVENT_NAMES) source.removeEventListener(name, dispatch);
      source.close();
      setConnected(false);
    };
  }, [path, enabled]);

  return { connected, lastEventAt };
}

/** Debounces a rapidly changing value (search boxes) without pulling in a library. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
