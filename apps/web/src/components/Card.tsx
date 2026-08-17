import type { ReactNode } from "react";

export interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Card({ title, subtitle, actions, children, className }: CardProps) {
  return (
    <section className={className ? `card ${className}` : "card"}>
      {(title || actions || subtitle) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export interface FieldRowProps {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
}

/** Label/value row used by the dashboard and diagnostics tables. */
export function FieldRow({ label, children, hint }: FieldRowProps) {
  return (
    <div className="field-row">
      <div className="field-label">{label}</div>
      <div className="field-value">
        {children}
        {hint && <div className="field-hint">{hint}</div>}
      </div>
    </div>
  );
}
