// Owned SVG geometry shared by the toolbar, message center and instant notices.
const svg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
export const messageIcons = {
  bell: svg(
    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4M12 2V1"/>',
  ),
  close: svg('<path d="m5 5 14 14M5 19 19 5"/>'),
  back: svg('<path d="m14 5-7 7 7 7"/>'),
  more: svg(
    '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  ),
  filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
  settings: svg(
    '<path d="m10 3-.5 2.2-1.8 1-2.1-.7-2 3.5L5.2 11v2L3.6 15l2 3.5 2.1-.7 1.8 1L10 21h4l.5-2.2 1.8-1 2.1.7 2-3.5-1.6-2v-2l1.6-2-2-3.5-2.1.7-1.8-1L14 3Z"/><circle cx="12" cy="12" r="3"/>',
  ),
};
