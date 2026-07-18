import type { JSX } from "react";

export function MoneyBagIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      {/* tied neck */}
      <path d="M9.2 2.2h5.6c.5 0 .8.5.6 1l-.9 1.8h-5l-.9-1.8c-.2-.5.1-1 .6-1z" />
      {/* sack body */}
      <path d="M8.6 6h6.8c3.1 2.3 4.6 5 4.6 8.1 0 4.2-2.7 7.7-8 7.7s-8-3.5-8-7.7C4 11 5.5 8.3 8.6 6z" />
      {/* dollar sign, cut out of the sack */}
      <text
        x="12"
        y="17.4"
        textAnchor="middle"
        fontSize="9.5"
        fontWeight="700"
        fill="var(--logo-bg, #fff)"
        fontFamily="inherit"
      >
        $
      </text>
    </svg>
  );
}
