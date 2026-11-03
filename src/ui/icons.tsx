import type { FileType } from '../models';

const PATHS = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  chat: 'M4 5h16v11H9l-5 4z',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z M10 20a2 2 0 0 0 4 0',
  plus: 'M12 5v14 M5 12h14',
  scan: 'M4 8h3l2-3h6l2 3h3v11H4z M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1',
  check: 'M4 4h16v16H4z M8 12l3 3 5-6',
  back: 'M15 5l-7 7 7 7',
  move: 'M4 12h13 M13 7l5 5-5 5',
  edit: 'M5 6h14 M5 10h14 M5 14h9 M5 18h11',
  refresh: 'M20 11a8 8 0 1 0-2 6 M20 5v6h-6',
  open: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  send: 'M4 12l16-8-6 16-3-7z',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  rename: 'M4 20h16 M7 16l1-4 8-8 3 3-8 8z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z',
  pdf: 'M6 3h8l5 5v13H6z M14 3v5h5 M9 13h7 M9 17h7',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M9 9.5h.01',
  audio: 'M9 18V6l10-2v12 M9 18a3 3 0 1 1-3-3 M19 16a3 3 0 1 1-3-3',
  other: 'M6 3h8l5 5v13H6z M14 3v5h5',
  lock: 'M6 11h12v10H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3 M12 15v2',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3 M9 21h6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 21, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name].split(' M').map((d, i) => (
        <path key={i} d={i === 0 ? d : `M${d}`} />
      ))}
    </svg>
  );
}

export const FileGlyph = ({ type, size = 34 }: { type: FileType; size?: number }) => <Icon name={type} size={size} />;
