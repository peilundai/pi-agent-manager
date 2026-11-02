import { useEffect, useState } from "react";

/** Pixel-art π mascot: a bar body with two eyes standing on two legs. */
const MASCOT_PIXELS = [
  "..XXXXXXXXXX..",
  ".XXXXXXXXXXXX.",
  "XXXXOXXXXOXXXX",
  "XXXXOXXXXOXXXX",
  "XXXXXXXXXXXXXX",
  "...XX....XX...",
  "...XX....XX...",
  "...XX....XXX..",
  "..XX......XX..",
];

export function PiMascot({ size = 7 }: { size?: number }) {
  const width = (MASCOT_PIXELS[0]?.length ?? 0) * size;
  const height = MASCOT_PIXELS.length * size;
  return (
    <svg className="mascot" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Pi">
      {MASCOT_PIXELS.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === "X" ? <rect key={`${x}-${y}`} x={x * size} y={y * size} width={size} height={size} /> : null,
        ),
      )}
    </svg>
  );
}

export function tipsFor(platform: string): string[] {
  const mod = platform === "darwin" ? "⌘" : "Ctrl+";
  return [
    "Type / for commands, prompt templates and skills.",
    "Use @ to mention a file from your workspace.",
    `Select code and press ${mod}L to add it to the chat.`,
    "Paste or drop images to show Pi a screenshot.",
    "Press Esc while Pi works to interrupt it.",
    `Messages sent while Pi works are queued. ${mod}Enter steers it immediately.`,
    "Pick a model and thinking level from the pill below.",
  ];
}

export function EmptyState({ platform, workspaceName }: { platform: string; workspaceName: string }) {
  const tips = tipsFor(platform);
  const [index, setIndex] = useState(() => Math.floor(Math.random() * tips.length));
  useEffect(() => {
    const timer = setInterval(() => setIndex((value) => (value + 1) % tips.length), 8_000);
    return () => clearInterval(timer);
  }, [tips.length]);
  return (
    <div className="empty-state">
      <PiMascot />
      <p className="empty-tip" aria-live="polite">
        {tips[index]}
      </p>
      {workspaceName && <p className="empty-workspace">{workspaceName}</p>}
    </div>
  );
}
