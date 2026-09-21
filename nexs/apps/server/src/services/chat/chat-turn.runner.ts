import {
  ApiError,
  type ChatMessage,
  type ChatToolCall,
  type SSEEventName,
  type SseFrame,
  type SsePayload,
  type StreamChunk,
  type ToolCallRequest,
  type ToolDefinition,
} from '@nexs/shared';
// The persisted row, which is a different shape from the prompt `ChatMessage` above: a row
// carries an id, a run link and an `interrupted` flag, none of which go to a provider.
import type { ChatMessage as ChatMessageRow } from '@prisma/client';
import type { Logger } from '../../logger.js';
import type { ChatMessageRepository } from '../../repositories/chat.repo.js';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { SseHub } from '../sse/sse-hub.js';
import type { ToolInvoker } from '../tools/tool-invoker.js';
import type { ModelGateway } from '../gateway/model-gateway.js';

/**
 * Runs one chat turn: the generation half of a conversation.
 *
 * ## Why this is a separate module from `ChatService`
 *
 * The two have opposite failure modes, and separating them is what lets each be honest.
 * `ChatService` writes to the database *before* it answers, so a failure is a failed HTTP
 * response with a status code. This module runs *after* the response is already streaming, so
 * a failure has nowhere to go but a frame — there is no status code left to send. Merging them
 * would mean one class that sometimes throws and sometimes streams, which is the shape that
 * produces "the request succeeded but nothing happened" bugs.
 *
 * ## The claim, and why exactly one generator wins
 *
 * A chat run is created by `ChatService.sendMessage` but never enqueued. It is claimed here,
 * by whichever stream connection is going to render it, via a compare-and-swap on the run's
 * status. So of N tabs open on the same session, exactly one generates and the rest observe:
 * the losers get `null` from `claim()` and simply stop. This is the same primitive the engine
 * uses, reused rather than reinvented — a run is claimed by whoever is willing to do the work,
 * and the database decides.
 *
 * ## The tool loop, and why it is bounded
 *
 * The spec's pipeline is: gateway stream -> on tool call -> `ToolInvoker` -> feed the result
 * back -> until a final answer. "Until a final answer" is an unbounded loop, and a model that
 * calls a failing tool will happily call it forever. The bound is not a safety rail bolted on
 * afterwards; it is the only thing that makes the `while` terminate, and its exhaustion is
 * reported to the user as a real outcome rather than silently truncating.
 */

/** How many tool round-trips a single turn may make before it is cut off. */
export const MAX_TOOL_ROUNDS = 8;

/**
 * A second destination for the frames this turn emits.
 *
 * ## Why the hub is not enough
 *
 * The hub is a fan-out to *observers* — other tabs, the run tail, the dashboard. It is not the
 * connection that asked for the answer. `POST /api/chat` answers with `text/event-stream`, and
 * for a long time nothing wrote to it: the runner published every frame to the hub, the hub
 * delivered them to whoever had called `hub.attach`, and the one caller of `attach` is
 * `GET /api/stream`. So the POST response carried its `: connected` comment and then sat there
 * for the whole turn, and the client only saw the answer when the turn ended and the transcript
 * was refetched. Measured: a 13-byte body and zero frames, on a turn that took 1.2 seconds.
 *
 * A sink is deliberately not "the response object". The runner does not know what a socket is,
 * and the caller that owns the transport is the one that should decide how a frame is encoded —
 * see `chat.controller.ts`, which encodes with the same `encodeSseFrame` the hub uses.
 */
export type ChatFrameSink = (frame: SseFrame) => void;

export interface ChatTurnRunnerDeps {
  gateway: ModelGateway;
  tools: ToolInvoker;
  messages: ChatMessageRepository;
  runs: RunRepository;
  hub: SseHub;
  logger: Logger;
  /** Injected so tests do not wait on wall-clock time. */
  now?: () => number;
}

export interface ChatTurnInput {
  tenantId: string;
  runId: string;
  sessionId: string;
  /**
   * The conversation so far, oldest first, including the user's newest message.
   *
   * The persisted rows, not the prompt shape: the runner is the thing that translates between
   * them, and taking rows here is what stops a caller from accidentally handing it a prompt it
   * built itself with a different idea of which messages belong in one.
   */
  history: ChatMessageRow[];
  /**
   * The agent's instructions, if the session has one.
   *
   * Passed separately from `history` because it is *not* conversation: it is the resolved
   * configuration of the pinned agent version. A `ChatMessage` row can never hold it — the
   * `ChatMessageRole` type deliberately excludes `'system'` for exactly this reason.
   */
  instructions?: string;
  modelId: string;
  /** The model's advertised capabilities, so a tool-less model is not sent tools. */
  toolDefinitions?: ToolDefinition[];
  /** Aborted when the last watcher of the run disconnects (gap #21). */
  signal?: AbortSignal;
  /**
   * The connection that asked for this turn, as a frame sink.
   *
   * Every frame the runner emits goes to the hub *and* here. Absent when a turn is driven
   * without a client attached — which is the case in most tests, and why this is optional
   * rather than required.
   */
  onFrame?: ChatFrameSink;
}

export interface ChatTurnResult {
  /** The persisted assistant message id, or null when the turn produced nothing to keep. */
  messageId: string | null;
  interrupted: boolean;
}

export class ChatTurnRunner {
  /**
   * In-flight turns by run id, so an unwatched run can be aborted from outside.
   *
   * The runner owns the `AbortController` rather than receiving one, because "cancel this run"
   * arrives through the SSE hub — a different call stack from the one generating — and the
   * controller has to be reachable from both. Keyed by run id because that is the only
   * identifier the hub knows.
   */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly deps: ChatTurnRunnerDeps) {}

  /**
   * Abort the turn for a run, if one is in flight.
   *
   * Called when the last watcher of a chat run disconnects (gap #21). A no-op when nothing is
   * generating, which is the common case: the hub fires this for any unwatched run, including
   * ones that finished long ago.
   */
  cancel(tenantId: string, runId: string): void {
    const controller = this.inFlight.get(runId);
    if (controller === undefined) return;

    this.deps.logger.info({ tenantId, runId }, 'aborting chat generation: last watcher left');
    controller.abort();
  }

  /**
   * Claim the run, generate, persist, and emit.
   *
   * Returns `null` when another connection already claimed the run — not an error, and not
   * something to log as one: losing the race is the normal outcome for every tab but the first.
   */
  async run(input: ChatTurnInput): Promise<ChatTurnResult | null> {
    const claimed = await this.deps.runs.claim(input.tenantId, input.runId, ['queued', 'running']);
    if (claimed === null) {
      this.deps.logger.debug(
        { tenantId: input.tenantId, runId: input.runId },
        'chat run already claimed by another connection',
      );
      return null;
    }

    // The caller's signal (the HTTP connection closing) and the runner's own (an unwatched
    // run) are composed into one, so either can stop the provider fetch. `AbortSignal.any`
    // would be the modern spelling, but a linked controller works on every supported runtime
    // and gives one obvious place to clear the map entry.
    const controller = new AbortController();
    this.inFlight.set(input.runId, controller);
    const linkAbort = (): void => controller.abort();
    if (input.signal !== undefined) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener('abort', linkAbort, { once: true });
    }

    const runInput: ChatTurnInput = { ...input, signal: controller.signal };

    this.emit(input, 'chat.started', { runId: input.runId });
    this.emit(input, 'run.started', { runId: input.runId });

    const transcript: ChatToolCall[] = [];
    // The assistant's text accumulates here and is what gets persisted. It is accumulated by
    // the caller rather than returned by `generate()`, because a turn can end three ways —
    // a final answer, the round bound, or an abort — and only the first of those produces text
    // through the normal path. Threading one accumulator through all three is what stops the
    // interrupted turn from throwing away the words the user already watched arrive.
    let text = '';

    try {
      const outcome = await this.generate(runInput, transcript, (delta) => {
        text += delta;
      });

      return await this.finalize(runInput, {
        text,
        transcript,
        interrupted: outcome.interrupted,
      });
    } catch (err) {
      // The response is already streaming, so a throw cannot become a status code. It becomes
      // a frame, and the run is marked failed so the run list agrees with what the user saw.
      const error = toErrorPayload(err);
      await this.deps.runs
        .setStatus(input.tenantId, input.runId, 'failed', { error: JSON.stringify(error) })
        .catch(() => {
          // Nothing useful to do: the failure being reported is the original one, and
          // replacing it with a second failure would hide the cause.
        });

      this.emit(input, 'chat.error', { runId: input.runId, error });
      this.emit(input, 'run.failed', { runId: input.runId, error });

      this.deps.logger.error(
        { err, tenantId: input.tenantId, runId: input.runId },
        'chat turn failed',
      );

      // Partial text typed before the failure is still kept: the user watched it arrive, and
      // discarding it would contradict what is on their screen.
      // If no text was produced before failure, provide a descriptive message in the transcript.
      const persistedText = text.length > 0 ? text : `[Generation failed: ${error.message}]`;
      const partial = await this.persist(input, { text: persistedText, transcript, interrupted: true });
      return { messageId: partial, interrupted: true };
    } finally {
      if (input.signal !== undefined) input.signal.removeEventListener('abort', linkAbort);
      this.inFlight.delete(input.runId);
    }
  }

  /**
   * The agent-style loop: stream, execute any tool calls, feed results back, repeat.
   *
   * The loop terminates on either a final answer (`done` with no tool calls) or the round
   * bound. Cancellation is checked at the top of each round *and* passed down as a signal, so
   * an abort lands during the provider call rather than after it.
   */
  private async generate(
    input: ChatTurnInput,
    transcript: ChatToolCall[],
    onDelta: (delta: string) => void,
  ): Promise<{ interrupted: boolean }> {
    const messages = buildPrompt(input);

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      if (isAborted(input.signal)) return { interrupted: true };

      const pending: ToolCallRequest[] = [];
      let roundText = '';

      for await (const chunk of this.streamOnce(input, messages)) {
        if (chunk.type === 'text') {
          roundText += chunk.text;
          onDelta(chunk.text);
          this.emit(input, 'chat.delta', { runId: input.runId, delta: chunk.text });
          continue;
        }
        if (chunk.type === 'tool_call') {
          pending.push(chunk.toolCall);
        }
      }

      // Aborted *during* this round. Checked before the "no tool calls means the model
      // answered" conclusion below, because an abort makes a stream end normally — the
      // provider closes the connection politely — and a generator that simply returns looks
      // identical to one that finished an answer. Without this check, cancelling mid-answer
      // produced a message marked complete with truncated text: the one outcome the
      // `interrupted` flag exists to prevent.
      //
      // Read through `isAborted` rather than as `input.signal?.aborted === true`, which looks
      // equivalent and is not: the check at the top of the round narrows the property to
      // `false | undefined` for the rest of the iteration, so the direct comparison compiles
      // to a provably-false branch. TypeScript is wrong to narrow it — `aborted` is flipped
      // from another tick, and the `for await` above is exactly where that happens — but the
      // honest fix is an accessor the compiler cannot narrow, not a cast that hides it.
      if (isAborted(input.signal)) return { interrupted: true };

      // No tool calls means the model answered. The text reached the window through `onDelta`,
      // and the caller holds it — nothing to return but the fact that the turn ended cleanly.
      if (pending.length === 0) return { interrupted: false };

      if (round === MAX_TOOL_ROUNDS) {
        // The bound is exhausted with the model still asking for tools. Reported as a
        // distinct outcome rather than a generic failure, because "it kept calling tools" is
        // actionable information and "it failed" is not.
        this.emit(input, 'chat.limit.reached', {
          runId: input.runId,
          limit: String(MAX_TOOL_ROUNDS),
        });
        return { interrupted: true };
      }

      // Feed the assistant's own ask back into the prompt *before* the results, or the model
      // sees tool outputs it never requested and has nothing to attach them to. The ask goes
      // in as `toolCalls` rather than as prose: a provider needs the structured request to
      // match each following `tool` result to its call by id, and a stringified form would
      // leave the results unattachable.
      messages.push({
        role: 'assistant',
        content: roundText,
        toolCalls: pending,
      });

      for (const call of pending) {
        const entry = await this.invokeTool(input, call, transcript);
        messages.push({
          role: 'tool',
          content: stringifyToolResult(entry),
          toolCallId: call.id,
        });
      }
    }

    // Unreachable: the loop returns on either the final answer or the bound. Kept so the
    // function has a total return rather than relying on the reader to prove the bound holds.
    return { interrupted: true };
  }

  /**
   * One gateway stream, translated into frames as it goes.
   *
   * ## Why the fallback chain is switched off for a chat turn
   *
   * `fallbackModelIds: []` is not "no fallbacks configured" — the gateway reads an *empty* list
   * as "the caller has decided", and stops at the one model rather than walking
   * `GatewayRoute.fallbackModelId` and then `Model.fallbackOf`. That is the behaviour a person
   * choosing a model expects: they picked one, and an answer silently produced by a different
   * model is worse than an error that names the model that failed. A substituted answer is
   * indistinguishable from the one they asked for, which is exactly the kind of fact this
   * codebase refuses to leave ambiguous.
   *
   * The engine's own runs keep their chain. There the fallback is a declared part of the agent's
   * configuration with its own tests, and nobody is watching the first byte arrive.
   */
  private streamOnce(input: ChatTurnInput, messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    return this.deps.gateway.stream({
      tenantId: input.tenantId,
      runId: input.runId,
      modelId: input.modelId,
      messages,
      // The model the turn was configured with, and only that one — see above.
      fallbackModelIds: [],
      ...(input.toolDefinitions === undefined || input.toolDefinitions.length === 0
        ? {}
        : { tools: input.toolDefinitions }),
      // Cancellation reaches the provider socket, which is what makes gap #21 real rather
      // than cosmetic: without this the fetch runs on after the last watcher has gone.
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  /**
   * Execute one tool call and record it.
   *
   * A tool that fails does not fail the turn. The failure is fed back to the model as the
   * tool's result, which is the entire point of an agent loop: the model gets to react to the
   * error — retry with different arguments, pick another tool, or explain the problem. Aborting
   * the turn instead would remove the only party capable of recovering from it.
   */
  private async invokeTool(
    input: ChatTurnInput,
    call: ToolCallRequest,
    transcript: ChatToolCall[],
  ): Promise<ChatToolCall> {
    this.emit(input, 'chat.tool_call', {
      runId: input.runId,
      toolName: call.name,
      args: call.args,
    });

    let entry: ChatToolCall;
    try {
      // The model names a tool; the registry resolves it. A name that is not a real tool id
      // is a model error and is reported as a failed tool, not thrown — see the comment above.
      const result = await this.deps.tools.invoke({
        tenantId: input.tenantId,
        runId: input.runId,
        toolId: call.name,
        args: (call.args ?? {}) as Record<string, unknown>,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      entry = {
        name: call.name,
        args: call.args,
        result: result.result,
        ok: result.ok,
      };
    } catch (err) {
      entry = {
        name: call.name,
        args: call.args,
        result: { error: toErrorPayload(err) },
        ok: false,
      };
    }

    transcript.push(entry);

    this.emit(input, 'chat.tool_result', {
      runId: input.runId,
      toolName: call.name,
      ok: entry.ok,
      result: entry.result,
    });
    this.emit(input, entry.ok ? 'tool.completed' : 'tool.failed', {
      runId: input.runId,
      toolName: call.name,
      ok: entry.ok,
      ...(entry.ok ? {} : { error: { code: 'TOOL_FAILED', message: `Tool ${call.name} failed` } }),
    });

    return entry;
  }

  /**
   * Persist the assistant message and close the run out.
   *
   * An assistant message is written even when it is empty-and-interrupted, because the client
   * that reconnects needs something to render in the place of the answer it watched start. The
   * `findAssistantForRun` check makes this update-in-place rather than append, so a retried
   * finalize cannot produce two assistant messages for one run.
   */
  private async finalize(
    input: ChatTurnInput,
    outcome: { text: string; transcript: ChatToolCall[]; interrupted: boolean },
  ): Promise<ChatTurnResult> {
    const messageId = await this.persist(input, outcome);

    if (outcome.interrupted) {
      await this.deps.runs.setStatus(input.tenantId, input.runId, 'cancelled').catch(() => {
        // A cancelled run whose status update failed is still cancelled from the user's point
        // of view; the message row is the durable record.
      });
      return { messageId, interrupted: true };
    }

    await this.deps.runs
      .setStatus(input.tenantId, input.runId, 'completed', { output: { messageId } })
      .catch((err: unknown) => {
        this.deps.logger.warn(
          { err, runId: input.runId },
          'chat run completed but its status could not be updated',
        );
      });

    this.emit(input, 'run.completed', { runId: input.runId, output: { messageId } });
    // Emitted last, and after the row exists: the frame names an id that a client can
    // immediately fetch, which is the whole basis of the reconnect contract.
    if (messageId !== null) {
      this.emit(input, 'chat.completed', { runId: input.runId, messageId });
    }

    return { messageId, interrupted: false };
  }

  /** Write the assistant message, updating in place if one already exists for this run. */
  private async persist(
    input: ChatTurnInput,
    outcome: { text: string; transcript: ChatToolCall[]; interrupted: boolean },
  ): Promise<string | null> {
    const existing = await this.deps.messages.findAssistantForRun(input.tenantId, input.runId);

    if (existing !== null) {
      const updated = await this.deps.messages.updateContent(input.tenantId, existing.id, {
        content: outcome.text,
        interrupted: outcome.interrupted,
        toolCalls: outcome.transcript,
      });
      return updated?.id ?? existing.id;
    }

    const created = await this.deps.messages.create({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      runId: input.runId,
      role: 'assistant',
      content: outcome.text,
      toolCalls: outcome.transcript,
      attachmentIds: [],
      interrupted: outcome.interrupted,
    });
    return created.id;
  }

  /**
   * Publish one frame — to the hub, and to the connection that asked for the turn.
   *
   * Generic over the event name so the payload is checked against the catalog in `events.ts`
   * rather than accepted as `unknown`: a frame is the one thing a client renders without being
   * able to validate it first, so a wrong shape here is invisible until it is on someone's
   * screen.
   *
   * ## The two sinks are independent, and both failures are survivable
   *
   * The hub fan-out and the response write are wrapped separately. They fail for different
   * reasons — a subscriber's socket is gone, versus the sender's socket is gone — and one
   * failing must not stop the other: a turn whose sender disconnected still has to reach the
   * second tab watching the run, and a turn whose hub fan-out threw still has to reach the
   * person who asked the question.
   *
   * Neither failure fails the turn. The assistant message is persisted by `finalize`
   * regardless, which is what makes a dropped frame a rendering problem rather than data loss.
   */
  private emit<N extends SSEEventName>(
    input: ChatTurnInput,
    name: N,
    payload: SsePayload<N>,
  ): void {
    try {
      this.deps.hub.publish({ name, payload }, input.tenantId);
    } catch (err) {
      // A frame that cannot be written is not a reason to fail a turn: the message is already
      // durable, and the SSE hub already isolates subscribers from each other's failures.
      this.deps.logger.warn({ err, name }, 'could not publish chat frame');
    }

    const onFrame = input.onFrame;
    if (onFrame === undefined) return;

    try {
      onFrame({ name, payload });
    } catch (err) {
      // The client's socket closed mid-write. `res.write` after `end` throws rather than
      // returning false, and a turn that stopped generating because nobody was listening would
      // contradict the claim that the message is durable — so this is a warning, not a failure.
      this.deps.logger.warn({ err, name }, 'could not write chat frame to the response stream');
    }
  }
}

/**
 * The prompt: instructions first when present, then the conversation.
 *
 * `'system'` appears here and nowhere else in the chat path — see `ChatMessageRole` for why a
 * persisted row can never carry it.
 */
function buildPrompt(input: ChatTurnInput): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (input.instructions !== undefined && input.instructions.length > 0) {
    messages.push({ role: 'system', content: input.instructions });
  }

  for (const message of input.history) {
    // A `tool` row is a rendering record rather than prompt content. The substance of a tool
    // exchange is carried by the assistant turn that requested it, which this runner rebuilds
    // per round — replaying the stored rows would re-send results the model never asked for.
    if (message.role === 'tool') continue;

    // The column is a plain `string`, so the role is narrowed rather than cast: a `'system'`
    // row is meant to be impossible (see `ChatMessageRole`), and a cast would let one through
    // and let a stored string masquerade as the agent's instructions.
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }

  return messages;
}

/** What the model is shown for a tool result, bounded so one huge output cannot flood the prompt. */
const TOOL_RESULT_MAX_CHARS = 4_000;

function stringifyToolResult(entry: ChatToolCall): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(entry.result ?? null);
  } catch {
    // A tool result containing a cycle or a BigInt cannot be serialized. Saying so is better
    // than throwing inside the loop and losing the turn.
    serialized = JSON.stringify({ error: { code: 'UNSERIALIZABLE', message: 'Tool result could not be serialized' } });
  }

  if (serialized.length <= TOOL_RESULT_MAX_CHARS) return serialized;
  return `${serialized.slice(0, TOOL_RESULT_MAX_CHARS)}…[truncated]`;
}

/**
 * Whether a signal has been aborted, in a form the compiler cannot narrow away.
 *
 * `signal?.aborted === true` is the obvious spelling and is a trap in a loop that checks it
 * both before and after an `await`: the pre-loop check narrows the property for the rest of
 * the iteration, so the post-loop check is compiled as provably false and silently never runs.
 * That is not a hypothetical — it is the bug this function was extracted to fix, and it is
 * invisible at runtime because the branch simply disappears.
 *
 * A function boundary defeats the narrowing legitimately: the compiler cannot see through the
 * call, which is correct, because `aborted` really does change from another tick.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function toErrorPayload(err: unknown): { code: string; message: string } {
  if (err instanceof ApiError) {
    const details =
      typeof err.details === 'object' && err.details !== null
        ? (err.details as Record<string, unknown>)
        : undefined;
    const lastError = typeof details?.['lastError'] === 'string' ? details['lastError'] : undefined;
    const message = lastError ? `${err.message} (${lastError})` : err.message;
    return { code: err.code, message };
  }
  return { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) };
}
