import { FIRST_STEPS, type FirstStepId } from "./firstSteps";
import { KEY, SHORTCUTS } from "./shortcuts";
import { TOOLS, type Tool } from "./tools";

interface FirstStepsPanelProps {
  readonly completed: readonly FirstStepId[];
  readonly onHide: () => void;
  readonly onTool: (tool: Tool) => void;
  readonly onCraft: () => void;
}

export function FirstStepsPanel({ completed, onHide, onTool, onCraft }: FirstStepsPanelProps) {
  const step = FIRST_STEPS.find((entry) => !completed.includes(entry.id));
  const craftShortcut = SHORTCUTS.find((entry) => entry.group === "panneaux" && entry.keys === KEY.craft);
  return (
    <aside className="first-steps" aria-label="Premiers pas" onContextMenu={(e) => e.preventDefault()}>
      <div className="first-steps-heading">
        <span>Premiers pas · {completed.length}/{FIRST_STEPS.length}</span>
        <button onClick={onHide}>Masquer</button>
      </div>
      <div aria-live="polite" aria-atomic="true">
        {completed.length > 0 && (
          <p className="first-steps-success">✓ {FIRST_STEPS.find((entry) => entry.id === completed[completed.length - 1])?.title} — Bien joué.</p>
        )}
        {step ? <><h2>{step.title}</h2><p>{step.instruction}</p></> : <p>Les premiers pas sont terminés, bonne continuation dans votre colonie.</p>}
      </div>
      {step && (
        <div className="first-steps-actions">
          {step.tools.map((id) => {
            const tool = TOOLS.find((entry) => entry.id === id)!;
            return <button key={id} onClick={() => onTool(id)}>{tool.label}{tool.key && <> <kbd>{tool.key}</kbd></>}</button>;
          })}
          {step.craft && craftShortcut && <button onClick={onCraft}>{craftShortcut.action} <kbd>{craftShortcut.keys}</kbd></button>}
        </div>
      )}
      {completed.length > 0 && (
        <details><summary>Étapes franchies ({completed.length})</summary>
          <ul>{FIRST_STEPS.filter((entry) => completed.includes(entry.id)).map((entry) => <li key={entry.id}>✓ {entry.title}</li>)}</ul>
        </details>
      )}
    </aside>
  );
}
