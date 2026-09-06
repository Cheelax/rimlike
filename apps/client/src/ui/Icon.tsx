const PATHS: Record<string, string> = {
  cursor: "m5 3 13 9-7 1-3 7-3-17Z",
  build: "m4 20 9-9m-4-6 3-3 8 8-3 3-8-8Zm-6 15 3 1 9-9",
  colony: "M4 21v-9l8-7 8 7v9H4Zm5 0v-7h6v7M2 12 12 3l10 9",
  world: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
  menu: "M4 6h16M4 12h16M4 18h16",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-2 4 6 6",
  close: "m6 6 12 12M6 18 18 6",
  play: "m8 4 12 8-12 8V4Z",
  pause: "M8 4v16M16 4v16",
  box: "m3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v10",
};
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name] ?? PATHS.box} /></svg>;
}
