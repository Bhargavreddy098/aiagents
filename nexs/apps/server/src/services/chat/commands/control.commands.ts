import type { ChatContext, CommandDraft, ParsedArgs } from './types.js';

/**
 * The commands that change the state of something already running, plus `/browser`.
 *
 * ## Why `/clear` is here and does nothing on the server
 *
 * §3.8 says `/clear` "clears composer state (client-side)". That is the spec being precise, and
 * this command honours it: it returns a reply saying so rather than deleting the conversation.
 * Deleting messages on a `/clear` would be a destructive surprise — a user clearing a text box
 * has not asked to lose their history.
 */
export function createControlCommands(ctx: ChatContext): CommandDraft[] {
  const { services } = ctx;

  return [
    {
      name: 'approve',
      usage: '/approve <approvalId>',
      description: 'Approve a pending approval, same as the inbox button',
      async run(args: ParsedArgs): Promise<{ reply: string }> {
        return decide(ctx, args, 'approved');
      },
    },

    {
      name: 'reject',
      usage: '/reject <approvalId>',
      description: 'Reject a pending approval, same as the inbox button',
      async run(args: ParsedArgs): Promise<{ reply: string }> {
        return decide(ctx, args, 'rejected');
      },
    },

    {
      name: 'stop',
      usage: '/stop <runId>',
      description: 'Cancel a run',
      async run(args: ParsedArgs): Promise<{ reply: string }> {
        const id = args.positional[0];
        if (id === undefined || id.length === 0) return { reply: 'Usage: `/stop <runId>`' };

        const run = await services.runs.cancel(ctx.tenantId, id);
        return { reply: `Run \`${run.id}\` is now \`${run.status}\`.` };
      },
    },

    {
      name: 'pause',
      usage: '/pause <runId>',
      description: 'Pause a run',
      async run(args: ParsedArgs): Promise<{ reply: string }> {
        const id = args.positional[0];
        if (id === undefined || id.length === 0) return { reply: 'Usage: `/pause <runId>`' };

        const paused = await services.runs.pause(ctx.tenantId, id);
        return {
          reply:
            `Run \`${paused.id}\` is now \`${paused.status}\`.\n\n` +
            `Resume it with \`/resume ${paused.id}\`.`,
        };
      },
    },

    {
      name: 'resume',
      usage: '/resume <runId>',
      description: 'Resume a paused run',
      async run(args: ParsedArgs): Promise<{ reply: string }> {
        const id = args.positional[0];
        if (id === undefined || id.length === 0) return { reply: 'Usage: `/resume <runId>`' };

        const run = await services.runs.resume(ctx.tenantId, id);
        return { reply: `Run \`${run.id}\` is now \`${run.status}\`.` };
      },
    },

    {
      name: 'clear',
      usage: '/clear',
      description: 'Clear the composer (client-side)',
      async run(): Promise<{ reply: string }> {
        return {
          reply:
            'The composer is cleared on the client. Nothing was deleted here — this ' +
            'conversation is still saved, and `/runs` still shows the work it produced.',
        };
      },
    },

    {
      name: 'browser',
      usage: '/browser <url> <screenshot|title|text>',
      description: 'Read a page in a headless browser',
      async run(args: ParsedArgs): Promise<{ reply: string }> {
        const url = args.positional[0];
        const action = (args.positional[1] ?? 'title').toLowerCase();

        if (url === undefined || url.length === 0) {
          return { reply: 'Usage: `/browser <url> <screenshot|title|text>`' };
        }
        if (action !== 'screenshot' && action !== 'title' && action !== 'text') {
          return {
            reply: `Unknown action \`${action}\`. Use \`screenshot\`, \`title\` or \`text\`.`,
          };
        }

        // Open, read, and always close — a leaked Chromium context is a real resource cost, and
        // the `finally` is what guarantees it even when the read throws.
        const session = await services.browser.open(ctx.tenantId, { url });
        try {
          if (action === 'title') {
            const result = await services.browser.act(ctx.tenantId, session.id, { type: 'inspect' });
            return {
              reply: `**${result.title ?? '(no title)'}**\n${result.currentUrl ?? url}`,
            };
          }

          if (action === 'screenshot') {
            const result = await services.browser.act(ctx.tenantId, session.id, {
              type: 'screenshot',
            });
            return {
              reply: `Captured \`${result.currentUrl ?? url}\`. The image is stored with the run's artefacts.`,
            };
          }

          // `text` reads the document body. `body` is the one selector every page has.
          const result = await services.browser.act(ctx.tenantId, session.id, {
            type: 'extract',
            selector: 'body',
          });
          const text = typeof result.output === 'string' ? result.output : '';
          if (text.trim().length === 0) {
            return { reply: `No readable text found at \`${result.currentUrl ?? url}\`.` };
          }
          return { reply: truncate(text.trim(), 4_000) };
        } finally {
          await services.browser.close(ctx.tenantId, session.id).catch(() => {
            // The read already succeeded or already failed; a failure to close must not replace
            // the answer the user asked for. A leaked context is swept by `reconcile()`.
          });
        }
      },
    },
  ];
}

/**
 * The shared body of `/approve` and `/reject`.
 *
 * One function rather than two, because the two differ in exactly one word and a duplicated
 * twenty-line body is where they would drift — a bug that silently makes `/reject` approve.
 */
async function decide(
  ctx: ChatContext,
  args: ParsedArgs,
  decision: 'approved' | 'rejected',
): Promise<{ reply: string }> {
  const id = args.positional[0];
  const verb = decision === 'approved' ? 'approve' : 'reject';

  if (id === undefined || id.length === 0) {
    return { reply: `Usage: \`/${verb} <approvalId>\`` };
  }

  // The decision is attributed to the user who typed it. A chat command must not be a way to
  // approve anonymously — the inbox's audit trail records who allowed what.
  const result = await ctx.services.approvals.decide(ctx.tenantId, id, ctx.userId, { decision });

  return {
    reply:
      `Approval \`${result.approval.id}\` is now \`${result.approval.status}\`.\n\n` +
      (decision === 'approved'
        ? 'The run has been resumed.'
        : 'The run has been told the action was refused.'),
  };
}

/** Trim to a bound, saying so, rather than pasting a whole page into the transcript. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…truncated (${text.length - max} more characters)`;
}
