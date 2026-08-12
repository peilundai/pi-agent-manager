import { useEffect, useRef, type KeyboardEvent } from "react";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel(): void;
  onConfirm(): void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);

  const trapFocus = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ) ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <section
        className="confirm-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          else trapFocus(event);
        }}
      >
        <div className="dialog-icon" aria-hidden="true">
          <span className="codicon codicon-warning" />
        </div>
        <div className="dialog-copy">
          <h2 id="confirm-dialog-title">{title}</h2>
          <p id="confirm-dialog-description">{description}</p>
        </div>
        <div className="dialog-actions">
          <button ref={cancelRef} className="button secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="button danger" type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
