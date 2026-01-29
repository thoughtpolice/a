interface ChipProps {
  label: string;
  onRemove?: () => void;
  onClick?: () => void;
  variant?: "default" | "active" | "muted";
  className?: string;
}

export function Chip({
  label,
  onRemove,
  onClick,
  variant = "default",
  className = "",
}: ChipProps) {
  const variantStyles = {
    default: "bg-[var(--bg-secondary)] text-[var(--text-primary)] border-[var(--border)]",
    active: "bg-[var(--accent-muted)] text-[var(--accent)] border-[var(--accent)]",
    muted: "bg-[var(--bg-secondary)] text-[var(--text-muted)] border-[var(--border)]",
  };

  return (
    <span
      class={`inline-flex items-center gap-1 px-2 py-1 text-sm rounded-md border
              ${variantStyles[variant]} ${onClick ? "cursor-pointer hover:border-[var(--border-hover)]" : ""} ${className}`}
      onClick={onClick}
    >
      <span class="truncate max-w-[180px]">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          class="ml-1 p-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </span>
  );
}
