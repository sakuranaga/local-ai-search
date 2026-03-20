import {
  useState,
  useRef,
  useCallback,
  cloneElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface TooltipProps {
  /** Tooltip content — string or JSX */
  content: ReactNode;
  /** Single child element (must accept onMouseEnter/onMouseLeave) */
  children: ReactElement;
  /** Only show when text is truncated (checks scrollWidth > clientWidth) */
  onlyWhenTruncated?: boolean;
  /** Additional class on the tooltip popup */
  className?: string;
  /** Delay before showing (ms). Default: 0 (instant) */
  delay?: number;
}

export function Tooltip({
  content,
  children,
  onlyWhenTruncated = false,
  className,
  delay = 0,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      // Clamp right edge to viewport
      const rect = node.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        node.style.left = `${window.innerWidth - 8 - rect.width}px`;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, pos],
  );

  const show = useCallback(
    (e: React.MouseEvent) => {
      const el = e.currentTarget as HTMLElement;
      if (onlyWhenTruncated && el.scrollWidth <= el.clientWidth) return;
      const rect = el.getBoundingClientRect();
      setPos({ left: rect.left, top: rect.top - 4 });
      if (delay > 0) {
        timerRef.current = setTimeout(() => setVisible(true), delay);
      } else {
        setVisible(true);
      }
    },
    [onlyWhenTruncated, delay],
  );

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  }, []);

  if (!isValidElement(children)) return children;

  const child = cloneElement(children as ReactElement<any>, {
    onMouseEnter: (e: React.MouseEvent) => {
      show(e);
      (children.props as any)?.onMouseEnter?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      hide();
      (children.props as any)?.onMouseLeave?.(e);
    },
  });

  return (
    <>
      {child}
      {visible && content && createPortal(
        <div
          ref={tooltipRef}
          className={cn(
            "fixed z-[100] max-w-xs px-2 py-1 text-xs rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 pointer-events-none",
            className,
          )}
          style={{
            left: pos.left,
            top: pos.top,
            transform: "translateY(-100%)",
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
