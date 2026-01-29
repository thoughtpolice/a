import { useState, useRef, useEffect } from "preact/hooks";

export interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchable?: boolean;
  className?: string;
}

export function Dropdown({
  options,
  value,
  onChange,
  placeholder = "Select...",
  searchable = false,
  className = "",
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  const filteredOptions = searchable && search
    ? options.filter((o) =>
        o.label.toLowerCase().includes(search.toLowerCase())
      )
    : options;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen && searchable && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen, searchable]);

  return (
    <div ref={containerRef} class={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        class="w-full flex items-center justify-between gap-2 px-3 py-2
               bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md
               text-[var(--text-primary)] text-sm
               hover:border-[var(--border-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
      >
        <span class={selectedOption ? "" : "text-[var(--text-muted)]"}>
          {selectedOption?.label || placeholder}
        </span>
        <svg
          class={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isOpen && (
        <div
          class="absolute z-50 w-full mt-1 bg-[var(--bg-secondary)] border border-[var(--border)]
                    rounded-md shadow-lg max-h-60 overflow-auto"
        >
          {searchable && (
            <div class="p-2 border-b border-[var(--border)]">
              <input
                ref={inputRef}
                type="text"
                value={search}
                onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                placeholder="Search..."
                class="w-full px-2 py-1 bg-[var(--bg-primary)] border border-[var(--border)]
                       rounded text-sm text-[var(--text-primary)]
                       focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
            </div>
          )}
          {filteredOptions.length === 0 ? (
            <div class="px-3 py-2 text-sm text-[var(--text-muted)]">
              No options found
            </div>
          ) : (
            filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                  setSearch("");
                }}
                class={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-hover)]
                        ${
                  option.value === value
                    ? "bg-[var(--bg-hover)] text-[var(--accent)]"
                    : "text-[var(--text-primary)]"
                }`}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
