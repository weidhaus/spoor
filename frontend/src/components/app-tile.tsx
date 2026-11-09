import { useState } from "react";

const TILE = "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-line";

/** The vendor's favicon, cached by our server from the app's website. Falls back to a neutral initials tile
 *  when no website is known or no icon exists; nothing is fabricated. */
export function AppTile({ id, name, website }: { id: number; name: string; website: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (website && failed !== website) {
    // The website in the URL makes the browser cache follow edits to it.
    return (
      <span aria-hidden className={`${TILE} bg-white p-1`}>
        <img src={`/api/applications/${id}/icon?w=${encodeURIComponent(website)}`} alt="" className="size-full object-contain" onError={() => setFailed(website)} />
      </span>
    );
  }
  const initials = name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span aria-hidden className={`${TILE} bg-surface-subtle text-xs font-semibold text-fg-secondary`}>
      {initials || "?"}
    </span>
  );
}
