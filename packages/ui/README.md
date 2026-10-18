# Grill UI

Import `mountGrill` from `src/grill.js` and load `src/grill.css`. The host supplies a
bounded height and a flex column containing the mount root. The root fills the available
space with `flex: 1; min-height: 0`; it does not position itself against the viewport.
For example, an embedded panel can use `display: flex; flex-direction: column; height: 500px`.
Question bodies and lists scroll internally; the top and answer bar stay accessible.

Single-choice names are compact answer chips. Their descriptions are separate, swipeable
reading content rendered safely with text nodes, bold and code. Multiple-choice questions
retain toggle controls and an explicit Next button. Horizontal body drags use the original
35% distance threshold, or 20% with velocity above 0.5 px/ms; vertical drags scroll. Buttons,
inputs and other interactive elements do not start swipes.

The standalone server host owns its viewport constraint and Copy answers footer. It also
owns encrypted links, local progress, offline recovery, sending, and the done/pickup screen;
these are host behavior rather than responsibilities of this UI package. Its viewport meta
requests `interactive-widget=resizes-content` for software keyboards where supported.
Browsers that ignore this request retain their native keyboard scrolling/panning behavior;
there is no JavaScript visualViewport fallback. Resized browser tests simulate a smaller
viewport; behavior with a physical phone's software keyboard remains unverified.
