import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";

// Keep tool renderers independent of either host's TUI component API.
export function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;

  const ellipsisWidth = stringWidth(ellipsis);
  if (ellipsisWidth >= width) return sliceAnsi(ellipsis, 0, width);
  return `${sliceAnsi(text, 0, width - ellipsisWidth)}${ellipsis}`;
}
