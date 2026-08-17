import type { ReactNode } from "react";

export interface ToolbarProps {
  children: ReactNode;
  right?: ReactNode;
  wrap?: boolean;
}

/** Horizontal control strip: filters on the left, actions on the right. */
export function Toolbar({ children, right, wrap = true }: ToolbarProps) {
  return (
    <div className={wrap ? "toolbar wrap" : "toolbar"}>
      <div className="toolbar-main">{children}</div>
      {right && <div className="toolbar-right">{right}</div>}
    </div>
  );
}

export interface LabeledProps {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  wide?: boolean;
}

export function Labeled({ label, children, hint, wide = false }: LabeledProps) {
  return (
    <label className={wide ? "labeled wide" : "labeled"}>
      <span className="labeled-text">{label}</span>
      {children}
      {hint && <span className="labeled-hint">{hint}</span>}
    </label>
  );
}
