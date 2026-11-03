import { tokenize } from '../search/folderSearch';

/**
 * Skills group actions so the model sees only the few it needs. Small on-device models choose badly
 * from a long list. Matching is plain word lookup in English, Hinglish and Hindi, with no model call,
 * so it is instant and predictable.
 */
export interface Skill {
  name: string;
  /** Single words match whole words; phrases and Devanagari match anywhere in the message. */
  triggers: string[];
  actions: string[];
}

const FIND = ['files.search', 'files.list'];

export const SKILLS: Skill[] = [
  {
    name: 'organize',
    triggers: [
      'move', 'rename', 'favourite', 'favorite', 'favourites', 'favorites', 'star', 'unstar', 'trash', 'delete', 'remove', 'bin',
      'ले जाओ', 'भेजो', 'नाम बदल', 'हटाओ', 'हटा दो', 'डिलीट', 'मिटाओ', 'पसंदीदा',
    ],
    actions: [...FIND, 'files.move', 'files.rename', 'files.setFavorite', 'files.trash'],
  },
  {
    name: 'open',
    // Not "show"/"दिखाओ": "show Aadhaar" is answered instantly by the folder listing, with no model.
    triggers: ['open', 'go to', 'switch to', 'kholo', 'खोलो', 'खोल दो'],
    actions: [...FIND, 'files.open', 'app.openTab'],
  },
  {
    name: 'reminders',
    triggers: ['remind', 'reminder', 'reminders', 'due', 'याद', 'रिमाइंडर'],
    actions: ['reminders.list', 'reminders.markDone', 'files.search'],
  },
  {
    name: 'pdf-tools',
    // Verbs only, not "pdf": "what is in the bill pdf?" is a question, not a command.
    triggers: [
      'merge', 'combine', 'join', 'split', 'extract', 'compress', 'shrink', 'smaller', 'reduce', 'watermark', 'rotate',
      'page numbers', 'number the pages', 'convert', 'make a pdf', 'make pdf', 'into a pdf', 'into one pdf',
      'मर्ज', 'जोड़ो', 'जोड़ दो', 'अलग करो', 'छोटा करो', 'साइज कम', 'घुमाओ', 'पीडीएफ बनाओ',
    ],
    actions: [...FIND, 'pdf.merge', 'pdf.extractPages', 'pdf.split', 'pdf.deletePages', 'pdf.rotate', 'pdf.compress', 'pdf.watermark', 'pdf.addPageNumbers', 'pdf.imagesToPdf'],
  },
  {
    name: 'expenses',
    triggers: ['spent', 'spend', 'spending', 'expense', 'expenses', 'kharch', 'kharcha', 'खर्च', 'खर्चा'],
    actions: ['expenses.summary', 'app.openTab'],
  },
];

const ASCII_WORD = /^[a-z]+$/;

function matches(message: string, words: Set<string>, trigger: string): boolean {
  return ASCII_WORD.test(trigger) ? words.has(trigger) : message.includes(trigger);
}

/** Skills the message asks for, in SKILLS order. Empty means: not a command. */
export function matchSkills(message: string): Skill[] {
  const lower = message.toLowerCase();
  const words = new Set(tokenize(lower));
  return SKILLS.filter((s) => s.triggers.some((t) => matches(lower, words, t)));
}

/** The union of the skills' actions, without duplicates. */
export const actionsFor = (skills: Skill[]): string[] => [...new Set(skills.flatMap((s) => s.actions))];
