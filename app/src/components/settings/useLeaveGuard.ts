import { useEffect, useRef, useState } from 'react';
import { navigate, setNavigationGuard } from '../../app/router.js';

/**
 * Holds the person on a screen with unsaved relay settings until they choose Save, Discard or Keep editing. Covers
 * in-app links and tabs (the router's guard), browser Back (the path is put back and the question asked) and closing
 * or reloading the page (the browser's own prompt).
 */
export function useLeaveGuard(dirty: boolean) {
  const [pending, setPending] = useState<string | null>(null);
  const here = useRef('');
  const released = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    here.current = location.pathname + location.search;
    released.current = false;
    const offNav = setNavigationGuard((to) => {
      if (released.current) return true;
      setPending(to);
      return false;
    });
    const onPop = () => {
      if (released.current) return;
      const now = location.pathname + location.search;
      // A sheet closing pops a history entry without changing the path; that is not leaving.
      if (now === here.current) return;
      // Put the path back in the same task, so the router never renders the screen being left.
      history.pushState(null, '', here.current);
      setPending(now);
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      offNav();
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty]);

  return {
    /** Where the person was going, while the question is open. */
    pending,
    /** Keep editing: stay, with the edits. */
    stay: () => setPending(null),
    /** Go where they were going, without asking again. */
    leave: () => {
      const to = pending;
      setPending(null);
      released.current = true;
      if (to) navigate(to);
    },
  };
}
