/**
 * The agent creation wizard — §4-PHASE13.3's *"name → instructions → model picker from real
 * models → tools/MCP/connectors checkboxes → capability toggles → approval policy"*.
 *
 * Every picker reads a real catalog (`useModels`, `useTools`, `useMcpServers`,
 * `useConnectors`), so the wizard cannot offer a model the workspace does not have — the
 * failure mode of a hard-coded list being that an agent is created pinned to a model id that
 * does not exist, and fails on its first run.
 *
 * ## One thing the form states plainly rather than implying
 *
 * `connectorAccountIds` is stored and mapped but **gates nothing** — the engine's allowlist
 * is `AgentContext.allowedToolIds`, which comes from the snapshot's `toolIds`. A connector's
 * tools only reach the planner if they are checked in the *Tools* step. So the Connectors
 * step says so in as many words: an operator who ticks a connector account and expects its
 * actions to be available would otherwise ship an agent that silently cannot use them.
 */

import { useState, type ReactNode } from 'react';
import { APPROVAL_POLICY_MODES, type CreateAgentInput } from '@nexs/shared';
import { Button, Checkbox, Field, Modal } from '../../components/ui';
import { labelForStatus } from '../../lib/status';
import { useConnectors, useMcpServers, useModels, useTools } from '../catalog/queries';
import { useCreateAgent } from './queries';

const STEPS = ['Identity', 'Instructions', 'Model', 'Capabilities', 'Policy'] as const;
type Step = (typeof STEPS)[number];

interface Draft {
  name: string;
  description: string;
  instructions: string;
  modelId: string;
  fallbackModelId: string;
  toolIds: string[];
  mcpServerIds: string[];
  connectorAccountIds: string[];
  memoryEnabled: boolean;
  browserAccess: boolean;
  sandboxAccess: boolean;
  approvalMode: (typeof APPROVAL_POLICY_MODES)[number];
  minRiskLevel: 'low' | 'medium' | 'high';
}

const INITIAL: Draft = {
  name: '',
  description: '',
  instructions: '',
  modelId: '',
  fallbackModelId: '',
  toolIds: [],
  mcpServerIds: [],
  connectorAccountIds: [],
  memoryEnabled: true,
  browserAccess: false,
  sandboxAccess: false,
  approvalMode: 'risk-based',
  minRiskLevel: 'medium',
};

/** Toggle a value in a string array without mutating it. */
function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export function CreateAgentWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (agentId: string) => void;
}): ReactNode {
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const [error, setError] = useState<unknown>(null);

  const models = useModels();
  const tools = useTools();
  const mcp = useMcpServers();
  const connectors = useConnectors();
  const create = useCreateAgent();

  const step: Step = STEPS[stepIndex] ?? 'Identity';

  const patch = (changes: Partial<Draft>): void => setDraft((current) => ({ ...current, ...changes }));

  const canAdvance = (): boolean => {
    if (step === 'Identity') return draft.name.trim().length > 0;
    return true;
  };

  const submit = async (): Promise<void> => {
    setError(null);
    // Omitted rather than sent empty: the schema is `.strict()` and takes `optional`, and an
    // empty string is a different value from "not set".
    const input: CreateAgentInput = {
      name: draft.name.trim(),
      instructions: draft.instructions,
      toolIds: draft.toolIds,
      mcpServerIds: draft.mcpServerIds,
      connectorAccountIds: draft.connectorAccountIds,
      memoryEnabled: draft.memoryEnabled,
      browserAccess: draft.browserAccess,
      sandboxAccess: draft.sandboxAccess,
      approvalPolicy: {
        mode: draft.approvalMode,
        ...(draft.approvalMode === 'risk-based' ? { minRiskLevel: draft.minRiskLevel } : {}),
      },
      ...(draft.description.trim().length > 0 ? { description: draft.description.trim() } : {}),
      ...(draft.modelId !== '' ? { modelId: draft.modelId } : {}),
      ...(draft.fallbackModelId !== '' ? { fallbackModelId: draft.fallbackModelId } : {}),
    };

    try {
      const agent = await create.mutateAsync(input);
      onCreated(agent.id);
    } catch (err) {
      setError(err);
    }
  };

  const availableModels = (models.data ?? []).filter((model) => model.enabled);
  const availableTools = tools.data ?? [];

  return (
    <Modal
      title={`New agent · ${step} (${stepIndex + 1}/${STEPS.length})`}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={stepIndex === 0}
            onClick={() => setStepIndex((value) => Math.max(0, value - 1))}
          >
            Back
          </Button>
          {stepIndex < STEPS.length - 1 ? (
            <Button
              variant="primary"
              disabled={!canAdvance()}
              onClick={() => setStepIndex((value) => Math.min(STEPS.length - 1, value + 1))}
            >
              Next
            </Button>
          ) : (
            <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
              Create agent
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        {error !== null ? (
          <div className="error-box" role="alert">
            {error instanceof Error ? error.message : 'Could not create the agent.'}
          </div>
        ) : null}

        {step === 'Identity' ? (
          <>
            <Field label="Name" hint="How this agent appears everywhere in the workspace.">
              <input
                className="input"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>
            <Field label="Description" hint="Optional. What this agent is for.">
              <textarea
                className="textarea"
                style={{ fontFamily: 'inherit', minHeight: 72 }}
                value={draft.description}
                onChange={(event) => patch({ description: event.target.value })}
              />
            </Field>
          </>
        ) : null}

        {step === 'Instructions' ? (
          <Field
            label="Instructions"
            hint="The system prompt. This is what the agent is told before it plans."
          >
            <textarea
              className="textarea"
              style={{ minHeight: 220 }}
              value={draft.instructions}
              onChange={(event) => patch({ instructions: event.target.value })}
            />
          </Field>
        ) : null}

        {step === 'Model' ? (
          <>
            {models.isPending ? (
              <p className="muted small">Loading models…</p>
            ) : models.isError ? (
              <div className="error-box">Could not load models.</div>
            ) : availableModels.length === 0 ? (
              <div className="error-box">
                No enabled models. Add a provider and sync its models before creating an agent —
                an agent with no model cannot plan.
              </div>
            ) : (
              <>
                <Field label="Model" hint="Used for planning and for `ai` steps.">
                  <select
                    className="select"
                    value={draft.modelId}
                    onChange={(event) => patch({ modelId: event.target.value })}
                  >
                    <option value="">Not set</option>
                    {availableModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name} · {model.providerName}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  label="Fallback model"
                  hint="Optional. Used when the primary is unavailable."
                >
                  <select
                    className="select"
                    value={draft.fallbackModelId}
                    onChange={(event) => patch({ fallbackModelId: event.target.value })}
                  >
                    <option value="">None</option>
                    {availableModels
                      .filter((model) => model.id !== draft.modelId)
                      .map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name} · {model.providerName}
                        </option>
                      ))}
                  </select>
                </Field>
              </>
            )}
          </>
        ) : null}

        {step === 'Capabilities' ? (
          <>
            <Field
              label="Tools"
              hint="Only these can be offered to the model. A tool not listed here is unreachable."
            >
              <div className="stack-sm" style={{ maxHeight: 220, overflowY: 'auto' }}>
                {tools.isPending ? (
                  <span className="muted small">Loading tools…</span>
                ) : availableTools.length === 0 ? (
                  <span className="muted small">
                    No tools registered. Builtin tools appear once the server has derived them.
                  </span>
                ) : (
                  availableTools.map((tool) => (
                    <Checkbox
                      key={tool.id}
                      checked={draft.toolIds.includes(tool.id)}
                      onChange={() => patch({ toolIds: toggle(draft.toolIds, tool.id) })}
                      label={`${tool.name} · ${tool.source}`}
                      hint={tool.description ?? undefined}
                    />
                  ))
                )}
              </div>
            </Field>

            <Field label="MCP servers" hint="Servers this agent may call tools on.">
              <div className="stack-sm">
                {(mcp.data ?? []).length === 0 ? (
                  <span className="muted small">No MCP servers configured.</span>
                ) : (
                  (mcp.data ?? []).map((server) => (
                    <Checkbox
                      key={server.id}
                      checked={draft.mcpServerIds.includes(server.id)}
                      onChange={() =>
                        patch({ mcpServerIds: toggle(draft.mcpServerIds, server.id) })
                      }
                      label={`${server.name} · ${server.status}`}
                      hint={`${server.toolCount} tools`}
                    />
                  ))
                )}
              </div>
            </Field>

            <Field
              label="Connector accounts"
              hint="Stored on the agent for provenance. This does NOT grant the connector's tools — tick them under Tools above."
            >
              <div className="stack-sm">
                {(connectors.data ?? []).length === 0 ? (
                  <span className="muted small">No connectors configured.</span>
                ) : (
                  (connectors.data ?? []).map((connector) => (
                    <Checkbox
                      key={connector.id}
                      checked={draft.connectorAccountIds.includes(connector.id)}
                      onChange={() =>
                        patch({
                          connectorAccountIds: toggle(draft.connectorAccountIds, connector.id),
                        })
                      }
                      label={`${connector.name} · ${connector.status}`}
                      hint={`${connector.capabilityCount} capabilities, ${connector.accountCount} accounts`}
                    />
                  ))
                )}
              </div>
            </Field>
          </>
        ) : null}

        {step === 'Policy' ? (
          <>
            <Field label="Memory" hint="Whether the agent may read and write its memory store.">
              <Checkbox
                checked={draft.memoryEnabled}
                onChange={(checked) => patch({ memoryEnabled: checked })}
                label="Memory enabled"
              />
            </Field>

            <Field
              label="Browser access"
              hint="Whether this agent may drive a browser session."
            >
              <Checkbox
                checked={draft.browserAccess}
                onChange={(checked) => patch({ browserAccess: checked })}
                label="Browser access"
              />
            </Field>

            <Field label="Sandbox access" hint="Whether this agent may execute code.">
              <Checkbox
                checked={draft.sandboxAccess}
                onChange={(checked) => patch({ sandboxAccess: checked })}
                label="Sandbox access"
              />
            </Field>

            <Field
              label="Approval policy"
              hint="When a step must be confirmed by a human before it runs."
            >
              <select
                className="select"
                value={draft.approvalMode}
                onChange={(event) =>
                  patch({ approvalMode: event.target.value as Draft['approvalMode'] })
                }
              >
                {APPROVAL_POLICY_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {labelForStatus(mode)}
                  </option>
                ))}
              </select>
            </Field>

            {draft.approvalMode === 'risk-based' ? (
              <Field label="Minimum risk requiring approval">
                <select
                  className="select"
                  value={draft.minRiskLevel}
                  onChange={(event) =>
                    patch({ minRiskLevel: event.target.value as Draft['minRiskLevel'] })
                  }
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </Field>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
