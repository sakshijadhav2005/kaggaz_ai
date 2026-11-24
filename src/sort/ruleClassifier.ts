import type { Classifier } from '../interfaces';
import type { ClassificationResult, Folder, StoredFile } from '../models';
import { folderForQuery } from '../search/folderSearch';

const RULE_CONFIDENCE = 0.9;
const FILENAME_CONFIDENCE = 0.6;

interface ConditionJson {
  any_text?: string[];
  all_text?: string[];
  regex?: string;
}

export interface RuleJson {
  folder: Folder;
  all?: ConditionJson[];
  any?: ConditionJson[];
}

class Condition {
  private anyText?: string[];
  private allText?: string[];
  private regex?: RegExp;

  constructor(json: ConditionJson) {
    this.anyText = json.any_text?.map((t) => t.toLowerCase());
    this.allText = json.all_text?.map((t) => t.toLowerCase());
    this.regex = json.regex ? new RegExp(json.regex) : undefined;
  }

  matches(text: string, lower: string): boolean {
    if (this.anyText) return this.anyText.some((t) => lower.includes(t));
    if (this.allText) return this.allText.every((t) => lower.includes(t));
    return this.regex?.test(text) ?? false;
  }
}

class Rule {
  readonly folder: Folder;
  private all: Condition[];
  private any: Condition[];

  constructor(json: RuleJson) {
    this.folder = json.folder;
    this.all = (json.all ?? []).map((c) => new Condition(c));
    this.any = (json.any ?? []).map((c) => new Condition(c));
  }

  matches(text: string, lower: string): boolean {
    if (this.all.length === 0 && this.any.length === 0) return false;
    return this.all.every((c) => c.matches(text, lower)) && (this.any.length === 0 || this.any.some((c) => c.matches(text, lower)));
  }
}

/** Offline first pass. Rules live in rules.json; first match wins. */
export class RuleClassifier implements Classifier {
  private rules: Rule[];

  constructor(rules: RuleJson[]) {
    this.rules = rules.map((r) => new Rule(r));
  }

  async classify(file: StoredFile, text: string) {
    return this.classifySync(file.name, text);
  }

  classifySync(fileName: string, text: string): ClassificationResult | null {
    const lower = text.toLowerCase();
    for (const rule of this.rules) {
      if (rule.matches(text, lower)) return { folder: rule.folder, confidence: RULE_CONFIDENCE, source: 'rule' };
    }
    // Weak signal: the file name.
    const hinted = folderForQuery(fileName);
    return hinted ? { folder: hinted, confidence: FILENAME_CONFIDENCE, source: 'rule' } : null;
  }
}
