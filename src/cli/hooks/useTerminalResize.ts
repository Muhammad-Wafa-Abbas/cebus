import { useEffect, useRef } from 'react';

/**
 * Clears the terminal screen on width changes to prevent Ink resize ghosting.
 *
 * Ink's non-fullscreen mode miscounts lines on width change, causing
 * stacked/duplicated output. We clear the visible screen on width changes
 * so Ink's stale cursor-up math is harmless. Height-only changes are skipped.
 */
export function useTerminalResize(): void {
  const lastColumnsRef = useRef(process.stdout.columns ?? 120);

  useEffect(() => {
    const onResize = (): void => {
      const newCols = process.stdout.columns ?? 120;
      if (newCols !== lastColumnsRef.current) {
        lastColumnsRef.current = newCols;
        process.stdout.write('\x1b[2J\x1b[H');
      }
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
}
