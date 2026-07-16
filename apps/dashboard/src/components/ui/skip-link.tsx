import type { JSX } from "react";

export function SkipLink(): JSX.Element {
  return (
    <a
      href="#main"
      className="sr-only rounded-md bg-ink px-3 py-2 text-[13px] font-medium text-white focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100]"
    >
      Skip to content
    </a>
  );
}

export default SkipLink;
