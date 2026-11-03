import { z } from 'zod';

import type { StoredFile } from '../models';

/**
 * The Action Registry: every action the assistant can take is declared once with defineAction. The zod
 * schema validates what the model sends and also produces the action list in the model's prompt, so the
 * two can never drift apart. Voice and tests can invoke the same actions by id.
 */

/** What the app gives an action besides its arguments: navigation, set by the UI. */
export interface ActionContext {
  openFile(fileId: string, page?: number): void;
  openTab(tab: AppTab): void;
}

export const APP_TABS = ['library', 'ask', 'tools', 'expenses', 'reminders'] as const;
export type AppTab = (typeof APP_TABS)[number];

export interface ActionResult {
  /** What the model sees. Metadata only: never document text. */
  data: unknown;
  /** Shown to the user under the reply, e.g. search results. */
  files?: StoredFile[];
}

export interface ActionDef<S extends z.ZodObject = z.ZodObject> {
  /** "area.verb", e.g. "files.move". */
  id: string;
  /** One line for the model: what it does and when to use it. */
  summary: string;
  args: S;
  /**
   * True only for actions the user cannot undo in the app. The model's request is shown to the user as a
   * question and runs only after they confirm. Actions with no undo at all (delete forever) are not registered.
   */
  requiresConfirmation?: boolean;
  /** The confirmation question, e.g. "Move 'Bill.pdf' to Trash?". */
  confirmText?: (args: z.infer<S>) => Promise<string>;
  /** What to tell the user after a confirmed run (no model call is made then). */
  doneText?: (data: any) => string;
  handler: (args: z.infer<S>, ctx: ActionContext) => Promise<ActionResult>;
}

const ID_RE = /^[a-z]+\.[a-zA-Z]+$/;

/** Checks the definition when the module loads, so a broken action fails tests, not a user's request. */
export function defineAction<S extends z.ZodObject>(def: ActionDef<S>): ActionDef<S> {
  if (!ID_RE.test(def.id)) throw new Error(`Action id "${def.id}" must look like "area.verb".`);
  if (def.summary.trim() === '') throw new Error(`Action ${def.id} needs a summary.`);
  if (def.requiresConfirmation && !def.confirmText) throw new Error(`Action ${def.id} needs confirmText.`);
  return def;
}

export type InvokeOutcome =
  | { status: 'done'; result: ActionResult }
  | { status: 'needs_confirmation'; question: string; actionId: string; args: unknown }
  | { status: 'error'; error: string };

/** Short JSON-schema-like description of one argument, for the prompt. */
function describeProp(name: string, p: Record<string, any>, required: boolean): string {
  let type = p.enum ? p.enum.map((v: unknown) => JSON.stringify(v)).join(' | ') : (p.type ?? 'any');
  if (p.type === 'array' && p.items) type = `list of ${p.items.type ?? 'any'}`;
  return `${name}${required ? '' : '?'}: ${type}${p.description ? ` (${p.description})` : ''}`;
}

export class ActionRegistry {
  private actions = new Map<string, ActionDef<any>>();

  register(...defs: ActionDef<any>[]): this {
    for (const d of defs) {
      if (this.actions.has(d.id)) throw new Error(`Action ${d.id} is registered twice.`);
      this.actions.set(d.id, d);
    }
    return this;
  }

  get = (id: string) => this.actions.get(id);
  ids = () => [...this.actions.keys()];

  /** The action list for the prompt, limited to [ids] if given. */
  describe(ids?: string[]): string {
    const defs = ids ? ids.map((id) => this.actions.get(id)).filter((d): d is ActionDef<any> => !!d) : [...this.actions.values()];
    return defs
      .map((d) => {
        const schema = z.toJSONSchema(d.args) as { properties?: Record<string, any>; required?: string[] };
        const props = Object.entries(schema.properties ?? {}).map(([k, p]) => describeProp(k, p, !!schema.required?.includes(k)));
        return `- ${d.id}(${props.join(', ')}): ${d.summary}`;
      })
      .join('\n');
  }

  /**
   * Validates and runs an action. An action that needs confirmation runs only with [confirmed]; otherwise
   * the question to ask the user comes back. Errors come back as values so the model can correct itself.
   */
  async invoke(id: string, rawArgs: unknown, ctx: ActionContext, opts: { confirmed?: boolean } = {}): Promise<InvokeOutcome> {
    const def = this.actions.get(id);
    if (!def) return { status: 'error', error: `Unknown action "${id}". Use one from the list.` };
    const parsed = def.args.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
      return { status: 'error', error: `Bad arguments for ${id}: ${issues}` };
    }
    try {
      if (def.requiresConfirmation && !opts.confirmed) {
        return { status: 'needs_confirmation', question: await def.confirmText!(parsed.data), actionId: id, args: parsed.data };
      }
      return { status: 'done', result: await def.handler(parsed.data, ctx) };
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  }
}
