import type { JSX } from "react";
import type { StatusChip as StatusChipModel } from "../lib/format.js";
import { Badge } from "./ui/badge.js";

/** Renders a lib/format.ts StatusChip (outcome/proof/payment) as a Badge. */
export function StatusChip({ chip }: { chip: StatusChipModel }): JSX.Element {
  return (
    <Badge tone={chip.tone} title={chip.title}>
      {chip.label}
    </Badge>
  );
}

export default StatusChip;
