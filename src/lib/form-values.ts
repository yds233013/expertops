/**
 * Read what is actually in a form, rather than what React thinks is in it.
 *
 * A controlled input takes its value from component state, and that state only
 * exists once React has attached to the page. Somebody who starts typing in the
 * gap between the HTML arriving and the JavaScript running is typing into the
 * DOM, which state never sees. The form then submits blanks while the screen
 * still shows the words they wrote — the worst shape of data loss, because
 * nothing looks wrong until the operator opens an empty submission.
 *
 * Reading the DOM at submit time removes the gap. It is also simply where the
 * truth is: the browser owns the field, and a form has always known its own
 * values without help.
 *
 * Used by the pages a stranger loads cold — the application form and the
 * screening form. Operator screens are reached by client-side navigation from
 * an already-hydrated page, so they have no such gap to fall into.
 */
export function formValues(form: HTMLFormElement): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}

/** One entry per non-empty line, trimmed. Used for work-sample links. */
export function splitLines(value: string | undefined): string[] {
  return (value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** One entry per non-empty comma-separated item, trimmed. Used for skills. */
export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
