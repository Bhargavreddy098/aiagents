import { ALWAYS_ALLOWED_COMMANDS } from '@nexs/shared';
import type { ChatContext, CommandDraft } from './types.js';

/**
 * `/whoami` — identity, for every surface (v2 §9).
 *
 * ## Why this is a command and not a settings page
 *
 * v2 puts `/whoami` on the *always-allowed* floor alongside `/help`, which means a user on a
 * locked-down channel account can still run it. That is deliberate: "who does the gateway think
 * I am, and what may I do here?" is the question a restricted user has after being refused
 * something, and a floor that answered only `/help` would leave them unable to ask it.
 *
 * ## What it does not claim
 *
 * It reports the ids it was handed — user, workspace, conversation — and the policy in force. It
 * does **not** look up a display name, because that would be a second read that can fail and
 * leave the command half-answered. Every value here comes from the context the dispatcher
 * already authenticated, so it cannot disagree with what the gateway actually enforced.
 */
export function createIdentityCommands(ctx: ChatContext): CommandDraft[] {
  return [
    {
      name: 'whoami',
      usage: '/whoami',
      description: 'Show who the gateway thinks you are, and what you may run',
      async run(): Promise<{ reply: string }> {
        const policy = ctx.policy;
        const isAdmin = policy?.isAdmin ?? false;
        const allowed = policy?.userAllowedCommands;

        const lines = [
          '**You are**',
          '',
          `User — \`${ctx.userId}\``,
          `Workspace — \`${ctx.tenantId}\``,
          `Conversation — \`${ctx.sessionId}\``,
          '',
          `Command owner — ${isAdmin ? 'yes' : 'no'}`,
        ];

        // The restriction is only worth printing when there *is* one. Saying "unrestricted"
        // to a caller who never declared a policy explains a rule that is not in force.
        if (!isAdmin && allowed !== undefined) {
          const named =
            allowed.length === 0
              ? 'the floor only'
              : allowed.map((name) => `\`/${name}\``).join(', ');
          lines.push(
            '',
            `Restricted to — ${named}`,
            `Always available — ${ALWAYS_ALLOWED_COMMANDS.map((name) => `\`/${name}\``).join(', ')}`,
          );
        }

        return { reply: lines.join('\n') };
      },
    },
  ];
}