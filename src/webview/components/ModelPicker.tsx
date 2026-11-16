import { useEffect, useMemo, useRef, useState } from "react";
import type { PiModel, ThinkingLevel } from "../../pi/rpc-types";
import { THINKING_LEVELS } from "../../pi/rpc-types";

const LEVEL_LABEL: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

export function thinkingLabel(level: ThinkingLevel | undefined): string {
  return level ? LEVEL_LABEL[level] : "";
}

export function supportedLevels(model: PiModel | undefined): ThinkingLevel[] {
  if (!model?.reasoning) return ["off"];
  const map = model.thinkingLevelMap ?? {};
  return THINKING_LEVELS.filter((level) => {
    if (level in map) return map[level] !== null;
    // Pi's default: levels up to "high" are supported; xhigh/max only when mapped.
    return level !== "xhigh" && level !== "max";
  });
}

export function modelLabel(model: PiModel | undefined): string {
  if (!model) return "No model";
  return model.name || model.id;
}

export function ModelPicker({
  models,
  current,
  thinkingLevel,
  onSelectModel,
  onSelectLevel,
  onClose,
}: {
  models: PiModel[];
  current: PiModel | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  onSelectModel(model: PiModel): void;
  onSelectLevel(level: ThinkingLevel): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? models.filter((model) => `${model.provider} ${model.id} ${model.name ?? ""}`.toLowerCase().includes(needle))
      : models;
    return [...list].sort((left, right) => {
      const leftCurrent = left.id === current?.id && left.provider === current?.provider ? -1 : 0;
      const rightCurrent = right.id === current?.id && right.provider === current?.provider ? -1 : 0;
      return leftCurrent - rightCurrent || left.provider.localeCompare(right.provider) || modelLabel(left).localeCompare(modelLabel(right));
    });
  }, [models, query, current]);
  const levels = supportedLevels(current);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose]);

  return (
    <div className="popover model-picker" ref={ref} role="dialog" aria-label="Choose model">
      {levels.length > 1 && (
        <div className="picker-section">
          <div className="picker-label">Thinking</div>
          <div className="segmented" role="radiogroup" aria-label="Thinking level">
            {levels.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={level === thinkingLevel}
                className={`segment level-${level}${level === thinkingLevel ? " selected" : ""}`}
                onClick={() => onSelectLevel(level)}
              >
                {LEVEL_LABEL[level]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="picker-search">
        <span className="codicon codicon-search" aria-hidden="true" />
        <input
          autoFocus
          value={query}
          placeholder="Search models…"
          aria-label="Search models"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((value) => Math.min(value + 1, filtered.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) => Math.max(value - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const model = filtered[active];
              if (model) onSelectModel(model);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <div className="picker-list" role="listbox" aria-label="Models">
        {filtered.length === 0 && <div className="picker-empty">No models match.</div>}
        {filtered.map((model, index) => {
          const selected = model.id === current?.id && model.provider === current?.provider;
          return (
            <button
              key={`${model.provider}/${model.id}`}
              type="button"
              role="option"
              aria-selected={selected}
              className={`picker-item${index === active ? " active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => onSelectModel(model)}
            >
              <span className="picker-item-main">
                <span className="picker-item-title">{modelLabel(model)}</span>
                <span className="picker-item-sub">{model.provider}</span>
              </span>
              {selected && <span className="codicon codicon-check" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
