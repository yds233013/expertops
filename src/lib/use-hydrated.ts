'use client';

import { useEffect, useState } from 'react';

/**
 * False until React has attached to the page, true afterwards.
 *
 * The gap matters on any page loaded cold from a link. The HTML arrives first
 * and a form in it looks finished: the fields accept typing and the button
 * accepts clicks. But the button is inside a `<form>`, so a click in that gap
 * is a *native* submission — the browser posts the form the old-fashioned way,
 * navigates, and the page comes back empty with nothing recorded and nothing
 * said. The applicant has no idea their words are gone.
 *
 * Gating the submit control on this closes the gap: an early click does
 * nothing, the fields keep what was typed (they are uncontrolled, so the DOM
 * holds it), and the button becomes live a moment later.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
