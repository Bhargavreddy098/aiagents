/**
 * The empty-chat hero.
 *
 * ## Why the wordmark is its own component
 *
 * The display face is the one thing about this screen that is a *brand* decision rather than a
 * layout decision, and the two change on different schedules. Keeping the wordmark in its own
 * component means the typeface, the tracking and the engraved treatment can be replaced by
 * editing one `className` — with the sizing, the centring and the interaction rules around it
 * untouched.
 *
 * ## It renders for a *fresh draft*, not for "no session"
 *
 * A conversation that exists and has no messages is the same screen to the person looking at
 * it: an empty page with a prompt at the bottom. Gating this on `session === null` would show
 * the wordmark only until the first click and then a blank transcript forever after, which is
 * exactly the state the hero exists to avoid. `ChatPage` decides, using "no messages and no
 * turn in flight" as the test.
 *
 * ## `pointer-events: none` on the mark
 *
 * A 130px wordmark is the largest thing on screen and it is not a control. Without the guard it
 * would swallow the first click of anyone who tried to select it, and — worse — would be a
 * focusable-looking object that does nothing. It is decoration, so it is marked as decoration:
 * `aria-hidden`, and the copy below it carries the meaning.
 */

import type { ReactNode } from 'react';

/**
 * The mark itself.
 *
 * `NEXS AGENT` rather than `NEXS`: the product is the NEXS Agent Control Plane, and the
 * wordmark is the two words an operator would use to name it out loud. The letters are what the
 * reference design puts here, so the only thing this component owns is how they are drawn.
 */
function Wordmark(): ReactNode {
  return (
    <span className="wordmark" aria-hidden="true">
      NEXS<span className="wordmark-gap" />
      <span className="wordmark-thin">AGENT</span>
    </span>
  );
}

export interface HeroWordmarkProps {
  /** The supporting sentence. Kept a prop so a future personality can change it. */
  body: string;
  /** Anything that belongs under the copy but above the composer — the run-as picker, today. */
  children?: ReactNode;
}

export function HeroWordmark({ body, children }: HeroWordmarkProps): ReactNode {
  return (
    <div className="chat-hero">
      <div className="chat-hero-inner">
        <p className="chat-hero-eyebrow">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          Control plane
        </p>

        <Wordmark />

        <p className="chat-hero-body">{body}</p>

        {children === undefined ? null : <div className="chat-hero-extra">{children}</div>}
      </div>
    </div>
  );
}
