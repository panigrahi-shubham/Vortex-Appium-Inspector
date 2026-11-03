import type { Session } from '../appium/webdriver.ts';

/** Chromedriver may initially attach to a zero-sized advertising WebView. */
export async function selectWebWindow(session: Pick<Session, 'switchWindow' | 'executeArgs'>, handles: string[], requested?: string | null) {
  if (requested) {
    if (!handles.includes(requested)) throw new Error('The selected WebView page has closed. Refresh contexts and select it again.');
    await session.switchWindow(requested);
    return requested;
  }
  if (handles.length === 1) {
    await session.switchWindow(handles[0]);
    return handles[0];
  }
  const visible: string[] = [];
  for (const handle of handles) {
    try {
      await session.switchWindow(handle);
      const page = await session.executeArgs('return { width: window.innerWidth, height: window.innerHeight, hidden: document.hidden };', []) as { width: number; height: number; hidden: boolean };
      if (page.width > 0 && page.height > 0 && !page.hidden) visible.push(handle);
    } catch { /* A background page can disappear while contexts are enumerated. */ }
  }
  if (visible.length !== 1) throw new Error(visible.length ? 'Several WebView pages are visible. Select the intended page, then inspect again.' : 'No visible WebView page was found. Refresh contexts after the page finishes loading.');
  await session.switchWindow(visible[0]);
  return visible[0];
}
