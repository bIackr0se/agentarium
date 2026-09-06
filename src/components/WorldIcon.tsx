export type WorldIconName = "arrow" | "back" | "open" | "lens" | "settings" | "list" | "play" | "pause" | "frame" | "check" | "close" | "alert" | "clock" | "book" | "edit" | "dots";

const paths: Record<WorldIconName, string> = {
  arrow: "M4 12h16m-6-6 6 6-6 6",
  back: "M20 12H4m6-6-6 6 6 6",
  open: "M6 18 18 6M7 6h11v11",
  lens: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6",
  settings: "M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M10 15v6",
  list: "M8 5h12M8 12h12M8 19h12M3 5h.1M3 12h.1M3 19h.1",
  play: "m8 4 12 8-12 8Z",
  pause: "M8 5v14M16 5v14",
  frame: "M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M18 6 6 18",
  alert: "M12 4v10m0 5v.1",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-15v6l4 2",
  book: "M12 5C8 2 4 3 3 4v15c3-2 6-1 9 1 3-2 6-3 9-1V4c-1-1-5-2-9 1Zm0 0v15",
  edit: "m4 16 12-12 4 4L8 20H4Zm10-10 4 4",
  dots: "M5 12h.1M12 12h.1M19 12h.1",
};

export function WorldIcon({ name }: { name: WorldIconName }) {
  return <svg className="world-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
