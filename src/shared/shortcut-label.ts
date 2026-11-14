import manifest from "../../package.json";

const MAC_MODIFIER: Record<string, string> = {
  ctrl: "⌃",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
  cmd: "⌘",
  meta: "⌘",
  win: "⊞",
};

const OTHER_MODIFIER: Record<string, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  cmd: "Ctrl",
  meta: "Meta",
  win: "Win",
};

function formatChord(chord: string, mac: boolean): string {
  const pieces = chord.split("+");
  const key = pieces.at(-1) ?? "";
  const modifiers = pieces.slice(0, -1);
  const labels = mac ? MAC_MODIFIER : OTHER_MODIFIER;
  const keyLabel = key.length === 1 ? key.toUpperCase() : `${key.slice(0, 1).toUpperCase()}${key.slice(1)}`;
  const modifierLabels = modifiers.map((modifier) => labels[modifier] ?? modifier);
  return mac ? `${modifierLabels.join("")}${keyLabel}` : [...modifierLabels, keyLabel].join("+");
}

export function shortcutLabel(command: string, platform: string): string {
  const binding = manifest.contributes.keybindings.find((item) => item.command === command);
  if (!binding) throw new Error(`No keybinding contributed for ${command}`);
  const chord = platform === "darwin" && binding.mac !== undefined ? binding.mac : binding.key;
  return chord
    .split(" ")
    .map((part) => formatChord(part, platform === "darwin"))
    .join(" ");
}
