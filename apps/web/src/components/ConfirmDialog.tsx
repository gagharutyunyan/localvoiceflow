import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Typing this exact word is required before the confirm button unlocks. */
  requirePhrase?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  requirePhrase,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [phrase, setPhrase] = useState("");

  // The dialog stays mounted between openings, so the unlock phrase must be reset on
  // every open/close transition — not only on the paths that happen to go through
  // onClose (the footer Cancel button calls onCancel directly, for one).
  useEffect(() => {
    setPhrase("");
  }, [open]);

  const locked = requirePhrase !== undefined && phrase.trim() !== requirePhrase;

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? "danger" : "primary"}
            onClick={() => void confirm()}
            disabled={busy || locked}
          >
            {busy ? <Spinner inline label="Working…" /> : confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{message}</div>
      {requirePhrase !== undefined && (
        <label className="labeled">
          <span className="labeled-text">
            Type <code>{requirePhrase}</code> to continue
          </span>
          <input value={phrase} onChange={(event) => setPhrase(event.target.value)} autoFocus />
        </label>
      )}
    </Modal>
  );
}
