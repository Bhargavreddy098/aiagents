/**
 * The primitive layer.
 *
 * One module rather than twenty files: these are small, they are used everywhere, and a
 * page should import one thing. Each primitive owns exactly one visual decision, and no
 * page is allowed to make that decision itself — which is what keeps `paused` the same
 * amber in the run list and the task list.
 *
 * `QueryBoundary` is the important one. Every page in this app has the same three states
 * (loading, error, data) and the same rule about them: **an error must never render as an
 * empty list.** A table that shows "no runs" because the request 500'd is the exact
 * dishonesty this project forbids, and it is the default behaviour of hand-written query
 * handling. Routing every page through one boundary makes the correct thing the easy thing.
 */

import { useId, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { describeError } from '../lib/api';
import { badgeClass, dotClass, labelForStatus, toneFor, type BadgeTone, type Tone } from '../lib/status';

// ── buttons ───────────────────────────────────────────────────────────────────

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  type?: 'button' | 'submit';
  disabled?: boolean;
  loading?: boolean;
  title?: string;
  className?: string;
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  type = 'button',
  disabled = false,
  loading = false,
  title,
  className,
}: ButtonProps): ReactNode {
  const classes = [
    'btn',
    variant !== 'default' ? `btn-${variant}` : '',
    size === 'sm' ? 'btn-sm' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

// ── surfaces ──────────────────────────────────────────────────────────────────

export function Card({
  title,
  actions,
  children,
  flush = false,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}): ReactNode {
  return (
    <section className="card">
      {title !== undefined || actions !== undefined ? (
        <header className="card-head">
          <span className="card-title">{title}</span>
          {actions}
        </header>
      ) : null}
      <div className={flush ? 'card-body-flush' : 'card-body'}>{children}</div>
    </section>
  );
}

export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="page-head">
      <div className="stack-sm">
        <h1>{title}</h1>
        {subtitle !== undefined ? <p className="muted small">{subtitle}</p> : null}
      </div>
      {actions !== undefined ? <div className="row">{actions}</div> : null}
    </div>
  );
}

// ── status ────────────────────────────────────────────────────────────────────

export function Dot({ tone, title }: { tone: Tone; title?: string }): ReactNode {
  return <span className={dotClass(tone)} title={title} aria-hidden={title === undefined} />;
}

/**
 * A label with a tone.
 *
 * `tone` defaults to `neutral` rather than being required, because most badges are labels —
 * a run's kind, a trigger type, a count — and a label has no state to report. `neutral` is
 * therefore the honest default, not a placeholder.
 *
 * This is the one place a tone may be `accent`, which is not a status. `StatusBadge` below is
 * the component that must not be fudged: it derives its tone from the status, so a page cannot
 * render a `failed` row reading "Completed".
 */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }): ReactNode {
  return <span className={badgeClass(tone)}>{children}</span>;
}

/**
 * A status string as a badge.
 *
 * The label is derived from the status rather than passed in, so a page cannot render a
 * `failed` badge reading "Completed" — the one class of bug a shared component would not
 * otherwise prevent.
 */
export function StatusBadge({ status }: { status: string | null | undefined }): ReactNode {
  const tone = toneFor(status);
  return (
    <span className={badgeClass(tone)}>
      <Dot tone={tone} />
      {labelForStatus(status)}
    </span>
  );
}

// ── query states ──────────────────────────────────────────────────────────────

export function Loading({ label = 'Loading…' }: { label?: string }): ReactNode {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBox({
  code,
  message,
  onRetry,
}: {
  code?: string;
  message: string;
  onRetry?: () => void;
}): ReactNode {
  return (
    <div className="error-box" role="alert">
      {code !== undefined ? <div className="error-code">{code}</div> : null}
      <div>{message}</div>
      {onRetry !== undefined ? (
        <div style={{ marginTop: 8 }}>
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }): ReactNode {
  const { code, message } = describeError(error);
  return <ErrorBox code={code} message={message} onRetry={onRetry} />;
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint !== undefined ? <div className="small">{hint}</div> : null}
      {action !== undefined ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

export interface QueryBoundaryProps<T> {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  /** Rendered instead of `children` when the predicate is true. Defaults to never. */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  loadingLabel?: string;
}

/**
 * Render a query's three states.
 *
 * The error branch comes **before** the empty branch, and that order is the point: a failed
 * request has no data to be empty about, and checking `data.length === 0` first would turn
 * every 500 into a confident "nothing here".
 */
export function QueryBoundary<T>({
  query,
  children,
  isEmpty,
  empty,
  loadingLabel,
}: QueryBoundaryProps<T>): ReactNode {
  if (query.isPending) return <Loading label={loadingLabel} />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (isEmpty !== undefined && query.data !== undefined && isEmpty(query.data)) {
    return <>{empty ?? <EmptyState title="Nothing to show" />}</>;
  }
  if (query.data === undefined) return <EmptyState title="No data" />;
  return <>{children(query.data)}</>;
}

// ── stats ─────────────────────────────────────────────────────────────────────

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}): ReactNode {
  // `0` is styled as muted rather than hidden. The honesty rule says a number must trace to
  // a row; it does not say a real zero should be disguised. Dimming it distinguishes "none"
  // from "one" at a glance without inventing anything.
  const isZero = value === 0 || value === '0';
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={isZero ? 'stat-value is-zero' : 'stat-value'}>{value}</div>
      {hint !== undefined ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

// ── forms ─────────────────────────────────────────────────────────────────────

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {error !== undefined ? (
        <span className="field-error">{error}</span>
      ) : hint !== undefined ? (
        <span className="hint">{hint}</span>
      ) : null}
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <label className="row" style={{ alignItems: 'flex-start', cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        style={{ marginTop: 3 }}
      />
      <span className="stack-sm" style={{ gap: 0 }}>
        <span>{label}</span>
        {hint !== undefined ? <span className="hint">{hint}</span> : null}
      </span>
    </label>
  );
}

// ── tabs ──────────────────────────────────────────────────────────────────────

export interface TabDefinition {
  id: string;
  label: string;
  /** Rendered after the label — a count, usually. */
  badge?: ReactNode;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly TabDefinition[];
  active: string;
  onChange: (id: string) => void;
}): ReactNode {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.badge !== undefined ? <> {tab.badge}</> : null}
        </button>
      ))}
    </div>
  );
}

// ── overlays ──────────────────────────────────────────────────────────────────

/**
 * A panel that slides in over the page.
 *
 * The accessible name is wired with `aria-labelledby` rather than `aria-label={String(title)}`,
 * which is what this used to do: `title` is a `ReactNode`, and every drawer in this app passes
 * an element once its data has loaded — so the dialog announced itself to a screen reader as
 * "[object Object]". Pointing at the rendered heading is the only version that survives a
 * title that is not a string.
 */
export function Drawer({
  title,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  const titleId = useId();
  return (
    <>
      <div className="scrim" onClick={onClose} role="presentation" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="drawer-head">
          <span className="card-title" id={titleId}>
            {title}
          </span>
          <Button size="sm" variant="ghost" onClick={onClose} title="Close">
            ✕
          </Button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer !== undefined ? <footer className="drawer-foot">{footer}</footer> : null}
      </aside>
    </>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  const titleId = useId();
  return (
    <>
      <div className="scrim" onClick={onClose} role="presentation" />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="drawer-head">
          <span className="card-title" id={titleId}>
            {title}
          </span>
          <Button size="sm" variant="ghost" onClick={onClose} title="Close">
            ✕
          </Button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer !== undefined ? <footer className="drawer-foot">{footer}</footer> : null}
      </div>
    </>
  );
}

// ── misc ──────────────────────────────────────────────────────────────────────

export function KeyValue({ entries }: { entries: readonly [string, ReactNode][] }): ReactNode {
  return (
    <dl className="kv">
      {entries.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A progress bar from a ratio the caller computed.
 *
 * `total === 0` renders an empty bar rather than dividing by zero — and the caller is
 * expected to have a real denominator. There is no default of 100: a percentage with no
 * denominator is the kind of invented number the honesty rule is about.
 */
export function ProgressBar({ done, total }: { done: number; total: number }): ReactNode {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
    >
      <div className="progress-fill" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
    </div>
  );
}

export function Code({ children }: { children: string }): ReactNode {
  return <pre className="code">{children}</pre>;
}

/** A copy-to-clipboard button for a JSON/MD artifact. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): ReactNode {
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text);
      }}
      title="Copy to clipboard"
    >
      {label}
    </Button>
  );
}
