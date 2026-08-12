import { useEffect, useRef } from "react";

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
  useEffect(() => cancelRef.current?.focus(), []);

  return (
    <div className="dialog-backdrop">
      <section
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
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
