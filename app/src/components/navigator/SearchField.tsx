import { useEffect, useState, type KeyboardEvent, type Ref } from 'react';
import { CloseIcon, SearchIcon } from '../Icons.js';

/** The value `ms` after it last changed: local search runs on this, the field shows every keystroke. */
export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (Object.is(v, value)) return;
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms, v]);
  return v;
}

/**
 * Daintree's search field: a recessed well with a hairline and a magnifier, a neutral focus (no accent), a clear
 * button while it holds a query, and Escape that clears before it closes anything. A field that was opened from a
 * button (`onEscapeEmpty`) closes on Escape once it is empty, and can leave clearing to that button (`clearable`).
 */
export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  inputRef,
  describedBy,
  shortcut,
  id,
  className,
  clearable = true,
  onEscapeEmpty,
  onArrowDown,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
  describedBy?: string;
  shortcut?: string;
  id?: string;
  className?: string;
  clearable?: boolean;
  onEscapeEmpty?: () => void;
  /** Arrow Down leaves the field for the results (returns false when there are none). */
  onArrowDown?: () => boolean;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' && onArrowDown && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (onArrowDown()) e.preventDefault();
      return;
    }
    if (e.key !== 'Escape') return;
    if (value) {
      e.preventDefault();
      e.stopPropagation();
      onChange('');
    } else if (onEscapeEmpty) {
      e.preventDefault();
      e.stopPropagation();
      onEscapeEmpty();
    }
  };
  return (
    <div className={className ? `search-field ${className}` : 'search-field'}>
      <SearchIcon size={16} />
      <input
        ref={inputRef}
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={describedBy}
        aria-keyshortcuts={shortcut}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      {value && clearable ? (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          // The button goes once the field is empty: focus stays in the field (and a phone keeps its keyboard).
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            onChange('');
            e.currentTarget.parentElement?.querySelector('input')?.focus();
          }}
        >
          <CloseIcon size={14} />
        </button>
      ) : (
        shortcut && (
          <kbd className="search-kbd" aria-hidden="true">
            {shortcut.includes('Meta') ? '⌘K' : 'Ctrl K'}
          </kbd>
        )
      )}
    </div>
  );
}
