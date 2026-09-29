export function DisconnectedIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g transform="rotate(45 12 12)">
        <path d="M9 2v5M15 2v5M12 17v5" />
        <path d="M6 7h12v4a6 6 0 0 1-12 0z" />
      </g>
    </svg>
  );
}
