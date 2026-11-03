import { strings } from '../i18n';
import type { LlmClient } from '../interfaces';
import type { StoredFile } from '../models';
import type { ActionContext, ActionRegistry } from './registry';

/*
 * The tool loop. Neither hosted nor on-device Gemma is given native tool calling here, so the model
 * replies with one JSON object per turn: an action to run, or a reply to the user. The app runs the
 * action through the registry (which validates it), adds the result to the prompt and asks again.
 * The same loop works with both models because it only needs LlmClient.complete().
 */

export const MAX_ROUNDS = 5;
/** Results are cut to this many characters so the on-device model's small context is not overrun. */
const MAX_RESULT_CHARS = 1500;

/** An earlier turn, so follow-ups like "the second one" work. Files carry ids the model may reuse. */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  files?: { id: string; name: string }[];
}

export type AgentOutcome =
  | { kind: 'reply'; text: string; files?: StoredFile[] }
  | { kind: 'confirm'; question: string; actionId: string; args: unknown; files?: StoredFile[] };

export interface AgentDeps {
  llm: LlmClient;
  registry: ActionRegistry;
  ctx: ActionContext;
  /** The actions this request may use (from the matched skills). */
  actionIds: string[];
  history?: Turn[];
  today?: Date;
}

export type ModelStep = { kind: 'action'; action: string; args: unknown } | { kind: 'reply'; text: string };

/** The first complete {...} in [text], skipping braces inside strings. */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Reads the model's turn. Plain text with no usable JSON counts as a reply. */
export function parseModelStep(raw: string): ModelStep {
  const json = firstJsonObject(raw);
  if (json) {
    try {
      const o = JSON.parse(json) as { action?: unknown; args?: unknown; reply?: unknown };
      if (typeof o.action === 'string' && o.action) return { kind: 'action', action: o.action, args: o.args ?? {} };
      if (typeof o.reply === 'string') return { kind: 'reply', text: o.reply.trim() };
    } catch {
      // Not valid JSON: fall through.
    }
  }
  const text = raw.replace(/```(?:json)?/g, '').trim();
  return { kind: 'reply', text: text || 'Sorry, I could not work that out.' };
}

const clip = (s: string) => (s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}...(cut)` : s);

export function buildAgentPrompt(message: string, steps: string[], d: Pick<AgentDeps, 'registry' | 'actionIds' | 'history' | 'today'>): string {
  const earlier = (d.history ?? [])
    .slice(-4)
    .map((t) => {
      const files = t.files?.length ? ` [documents shown: ${t.files.map((f) => `"${f.name}" id ${f.id}`).join(', ')}]` : '';
      return `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}${files}`;
    })
    .join('\n');
  return [
    'You are the assistant inside Kaagaz, a private document vault app. You help by taking actions on the user\'s documents.',
    '',
    'Actions:',
    d.registry.describe(d.actionIds),
    '',
    'Reply with exactly one JSON object and nothing else:',
    '- to take an action: {"action": "<action id>", "args": {...}}',
    '- to answer the user: {"reply": "<short message>"}',
    '',
    'Rules:',
    '- Use only document ids that appear in results or in the conversation. Never invent ids.',
    '- To act on a document, find it first with files.search or files.list.',
    '- If several documents match and it is unclear which one is meant, ask the user in a reply, naming them.',
    '- One action per turn. After the action succeeds, reply saying what you did.',
    '- Reply in the language of the user (English or Hindi). Keep it short.',
    `- Today is ${(d.today ?? new Date()).toISOString().slice(0, 10)}.`,
    '',
    earlier ? `Earlier conversation:\n${earlier}\n` : '',
    `User: ${message}`,
    ...steps,
    '',
    'Your JSON:',
  ].join('\n');
}

/** Runs the loop for one user message. */
export async function runAgent(message: string, d: AgentDeps): Promise<AgentOutcome> {
  const steps: string[] = [];
  let files: StoredFile[] | undefined;
  let lastCall = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const step = parseModelStep(await d.llm.complete(buildAgentPrompt(message, steps, d)));
    if (step.kind === 'reply') return { kind: 'reply', text: step.text, files };

    const call = JSON.stringify({ action: step.action, args: step.args });
    steps.push(`Action: ${call}`);
    if (call === lastCall) {
      // Small models sometimes repeat themselves; push them to finish.
      steps.push('Result: {"error": "You already did exactly this. Now reply to the user."}');
      continue;
    }
    lastCall = call;
    if (!d.actionIds.includes(step.action)) {
      steps.push(`Result: ${JSON.stringify({ error: `Action ${step.action} is not available. Use one from the list.` })}`);
      continue;
    }

    const out = await d.registry.invoke(step.action, step.args, d.ctx);
    if (out.status === 'needs_confirmation') return { kind: 'confirm', question: out.question, actionId: out.actionId, args: out.args, files };
    if (out.status === 'error') {
      steps.push(`Result: ${JSON.stringify({ error: out.error })}`);
      continue;
    }
    if (out.result.files) files = out.result.files;
    steps.push(`Result: ${clip(JSON.stringify(out.result.data))}`);
  }
  return { kind: 'reply', text: strings().agent.gaveUp, files };
}

/** Runs an action the user has just confirmed and says what happened. */
export async function runConfirmed(registry: ActionRegistry, actionId: string, args: unknown, ctx: ActionContext): Promise<string> {
  const out = await registry.invoke(actionId, args, ctx, { confirmed: true });
  const t = strings().agent;
  if (out.status === 'error') return t.failed(out.error);
  if (out.status === 'needs_confirmation') return t.needsConfirm;
  return registry.get(actionId)?.doneText?.(out.result.data) ?? t.done;
}
