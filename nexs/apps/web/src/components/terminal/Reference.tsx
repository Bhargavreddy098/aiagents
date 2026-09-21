/**
 * §8 — the keybinding help overlay, and §9.3 — the `/context` grid.
 *
 * ## Why these two share a file
 *
 * Both are *reference* surfaces: neither acts on anything, both exist to tell a user what is
 * true, and both are reached the same way — from the command palette or a slash command. A file
 * per modal would be two files that each need the same "grouped rows with a reason on the
 * unavailable ones" treatment.
 *
 * ## The help overlay renders the gaps, and that is its point
 *
 * `lib/keybindings.ts` marks seven of the spec's rows unavailable with a reason — `Ctrl+Z`,
 * `Ctrl+D`, a `!command` shell, the `Ctrl+G` editor bridge and the rest. Omitting them would make
 * the overlay silently disagree with the spec it is derived from, and a user who read §8 would
 * reasonably conclude they had pressed the key wrong. So the overlay lists them under a heading
 * that says what they are, with the reason **in the row** rather than in a tooltip — a disabled
 * row with no visible explanation is the thing this project refuses to ship.
 *
 * ## The context grid is honest about being an estimate
 *
 * §9.3 draws the context window as a 5×20 ASCII grid. This build has **no live context
 * occupancy**: the token figure is summed from the session's run usage rows, and the denominator
 * is the model's own window rather than a measurement of what is currently loaded. So the grid
 * says so in a line of its own, and it renders *nothing* rather than an empty grid when either
 * number is missing. An all-empty grid beside a `0/0` would read as "the context is empty", which
 * is exactly the wrong conclusion.
 */

import { useMemo, type ReactNode } from 'react';
import {
  bindingsByGroup,
  PRIMARY_MODIFIER,
  KEY_BINDINGS,
  type KeyBinding,
} from '../../lib/keybindings';
import { contextBar, CONTEXT_BANDS, formatTokens, type ContextReading } from '../../lib/context';
import { Badge, Button, Modal } from '../ui';

// ── §8 the help overlay ─────────────────────────────────────────────────────

export interface KeybindingsOverlayProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The help overlay.
 *
 * `open` early-returns `null` because `Modal` renders as soon as it is mounted — it has no `open`
 * prop of its own, so the caller's flag has to become an unmount.
 */
export function KeybindingsOverlay({ open, onClose }: KeybindingsOverlayProps): ReactNode {
  /**
   * The spec's own `⌘` vs `Ctrl` distinction, resolved once.
   *
   * The table stores `Ctrl+K` with `⌘K` as an *alias* because that is how §8 writes it; on a Mac
   * the primary spelling is the `⌘` one, so the rows are rewritten for display rather than the
   * table being duplicated per platform.
   */
  const groups = useMemo(() => bindingsByGroup(KEY_BINDINGS), []);

  if (!open) return null;

  return (
    <Modal
      title="Keyboard shortcuts"
      onClose={onClose}
      footer={
        <span className="muted small">
          {KEY_BINDINGS.length} from the terminal spec · {unavailableCount()} not implementable in
          a browser tab, with the reason on each row
        </span>
      }
    >
      <div className="stack">
        {groups.map((group) => (
          <div className="stack-sm" key={group.group}>
            <h3 className="label">{group.group}</h3>
            <table className="table">
              <tbody>
                {group.bindings.map((binding) => (
                  <BindingRow key={binding.keys + binding.label} binding={binding} />
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <p className="muted small">
          A key marked unavailable is one this surface genuinely cannot honour — a page cannot
          suspend itself, close its own tab, or take over the browser's copy key. They are listed
          with the reason rather than hidden, so this table and the spec it comes from cannot
          disagree about what exists.
        </p>
      </div>
    </Modal>
  );
}

function unavailableCount(): number {
  return KEY_BINDINGS.filter((binding) => binding.unsupported !== null).length;
}

/**
 * One row.
 *
 * The keys are rendered as `<kbd>` chips, and the `Ctrl` spelling is swapped for the platform's
 * own primary modifier at this point. The substitution is on the *display* string only: the
 * table's `keys` value stays `Ctrl+K` so the matching in `unsupportedReasonFor` cannot break on a
 * Mac, where the displayed string no longer equals the stored one.
 */
function BindingRow({ binding }: { binding: KeyBinding }): ReactNode {
  const shown = displayKeys(binding.keys);

  return (
    <tr>
      <td style={{ width: 190 }}>
        <span className="row" style={{ gap: 4 }}>
          {shown.map((key, index) => (
            <kbd key={`${key}:${index}`}>{key}</kbd>
          ))}
        </span>
        {binding.aliases === undefined ? null : (
          <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
            or {binding.aliases.map((alias) => displayKey(alias)).join(' / ')}
          </div>
        )}
      </td>
      <td className="small">{binding.label}</td>
      <td className="small" style={{ width: 260 }}>
        {binding.unsupported === null ? (
          <Badge tone="ok">available</Badge>
        ) : (
          <span className="muted">{binding.unsupported}</span>
        )}
      </td>
    </tr>
  );
}

/** `Ctrl+K` → `['⌘', 'K']` on a Mac, `['Ctrl', 'K']` elsewhere. */
function displayKeys(keys: string): string[] {
  return keys.split('+').map((part) => displayKey(part.trim()));
}

function displayKey(part: string): string {
  if (part === 'Ctrl' || part === '⌘') return PRIMARY_MODIFIER;
  return part;
}

// ── §9.3 the `/context` grid ────────────────────────────────────────────────

export interface ContextGridProps {
  reading: ContextReading | null;
  /** True when the numerator is a cumulative total rather than a live occupancy. */
  approximate: boolean;
  /** Why the grid is approximate, or why it is absent. Shown verbatim. */
  note: string;
  /** The model's window size, for the label. */
  modelName?: string | null;
}

/**
 * §9.3's 5×20 grid.
 *
 * ## Why the grid is built from `readContext` rather than from its own arithmetic
 *
 * `lib/context.ts` owns the banding rules — `<50` green, `<80` yellow, `<95` orange, else red —
 * and the status bar reads the same function. Deriving a second band here would be two places
 * that can disagree about whether 80% is yellow, and the grid is the *more* visible of the two
 * surfaces, so a disagreement would be noticed here first and fixed in the wrong file.
 *
 * ## The rows are `contextBar`'s cells, five per row
 *
 * The spec draws five rows of twenty. `contextBar` is parameterised by width, so a 20-cell bar
 * sliced into four rows of five would be a *different* number of cells than the spec's hundred —
 * so the grid asks for twenty and lays them out five to a line, which is the shape §9.3 draws.
 */
export function ContextGrid({ reading, approximate, note, modelName }: ContextGridProps): ReactNode {
  if (reading === null) {
    return (
      <div className="stack-sm">
        <p className="muted small">{note}</p>
        <p className="muted small">
          Nothing is drawn rather than an empty grid: an all-blank chart beside a zero would read
          as "the context is empty", which is a different claim from "nobody measured it".
        </p>
      </div>
    );
  }

  const width = 20;
  const cells = reading.bar; // `contextBar(percent, width)` — the same 20 cells the label counts.
  const rows: string[] = [];
  for (let index = 0; index < cells.length; index += width) {
    rows.push(cells.slice(index, index + width));
  }

  const bandLabel: Record<ContextReading['band'], string> = {
    green: 'comfortable',
    yellow: 'filling up',
    orange: 'close to the limit',
    red: 'at the limit — expect compaction or a refusal',
  };

  return (
    <div className="stack-sm">
      <div className="row-wrap small">
        <Badge tone={bandTone(reading.band)}>{reading.band}</Badge>
        <span className="muted">
          {formatTokens(reading.used)} / {formatTokens(reading.max)}
          {modelName === undefined || modelName === null ? '' : ` · ${modelName}`}
          {' · '}
          {reading.percent}%
          {approximate ? ' (approximate)' : ''}
        </span>
      </div>

      <pre className="ctx-grid" aria-label={`Context window ${reading.percent} percent used`}>
        {rows.join('\n')}
      </pre>

      <p className="muted small">
        {bandLabel[reading.band]}. {note}
      </p>

      <details>
        <summary className="muted small" style={{ cursor: 'pointer' }}>
          The bands this is judged against
        </summary>
        <table className="table">
          <thead>
            <tr>
              <th>Band</th>
              <th>Used</th>
              <th>Means</th>
            </tr>
          </thead>
          <tbody>
            {CONTEXT_BANDS.map((entry) => (
              <tr key={entry.band}>
                <td>
                  <Badge tone={bandTone(entry.band)}>{entry.band}</Badge>
                </td>
                <td className="small nowrap">{bandRange(entry.from, entry.to)}</td>
                <td className="small muted">{BAND_MEANING[entry.band]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function bandTone(band: ContextReading['band']): 'ok' | 'waiting' | 'failed' {
  if (band === 'green') return 'ok';
  if (band === 'yellow' || band === 'orange') return 'waiting';
  return 'failed';
}

/**
 * A band's range as text: `0–50%`, `95%+`.
 *
 * `to === null` is the open-ended top band, not a missing value — the table in `lib/context.ts`
 * uses `null` for "no upper bound" because `100` would be a *closed* range and a reading above
 * 100% (which `contextPercent` can produce when the numerator exceeds the window) would then fall
 * outside every band. So the sentinel is rendered as `+` rather than as a number.
 */
function bandRange(from: number, to: number | null): string {
  return to === null ? `${from}%+` : `${from}–${to}%`;
}

/**
 * What each band means, in the operator's terms.
 *
 * Kept here rather than in `lib/context.ts` on purpose: that module is pure arithmetic over two
 * numbers and must not carry prose that can go stale, while this table exists to be *read*. The
 * numbers are not duplicated — they come from `CONTEXT_BANDS`; only the words live here.
 */
const BAND_MEANING: Record<ContextReading['band'], string> = {
  green: 'Room to spare; nothing to do.',
  yellow: 'Over halfway. Worth watching on a long session.',
  orange: 'Close to the window. Expect compaction soon.',
  red: 'At the window. Compaction or a refusal is likely.',
};

/**
 * `/context` as a modal, for the slash command.
 *
 * §9.3 marks `/context` "not yet available" server-side, so this is the **client's** answer to it:
 * the composer inserts the command, the server replies with the not-available sentence, and this
 * overlay is what an operator can actually open. It is reached from the status bar's context
 * meter, which is the affordance the spec's own `18.2K/200K` reading implies.
 */
export function ContextModal({
  open,
  onClose,
  reading,
  approximate,
  note,
  modelName,
}: ContextGridProps & { open: boolean; onClose: () => void }): ReactNode {
  if (!open) return null;
  return (
    <Modal
      title="Context window"
      onClose={onClose}
      footer={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <ContextGrid
        reading={reading}
        approximate={approximate}
        note={note}
        modelName={modelName}
      />
    </Modal>
  );
}

/** Re-exported so a caller drawing the grid does not have to reach into `lib/context` too. */
export { contextBar };
