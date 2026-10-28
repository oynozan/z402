import type { ReactNode } from "react";
import { CopyCell } from "./copy";

/** pay.sh's TRY NOW box, a label over the command with a copy cell at its end */
export function CommandBox({ label, command, children }: { label: string; command: string; children: ReactNode }) {
  return (
    <div className="try">
      <p className="try-label">{label}</p>
      <div className="try-cmd">
        <code>{children}</code>
        <CopyCell text={command} label={command} />
      </div>
    </div>
  );
}
