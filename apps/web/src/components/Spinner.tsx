export interface SpinnerProps {
  label?: string;
  inline?: boolean;
}

export function Spinner({ label = "Loading…", inline = false }: SpinnerProps) {
  return (
    <span className={inline ? "spinner-wrap inline" : "spinner-wrap"} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="spinner-label">{label}</span>
    </span>
  );
}
