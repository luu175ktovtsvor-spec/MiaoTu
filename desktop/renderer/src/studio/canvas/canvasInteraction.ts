// A gesture owns its cleanup until the native end event, cancellation or loss
// of the page. Floating panels never create one of these canvas gestures.
export function watchCanvasInteractionEnd(source: MouseEvent | TouchEvent | PointerEvent, finish: () => void, pointerRelease = false) {
  const doc = (source.target as Node | null)?.ownerDocument ?? document;
  const view = doc.defaultView ?? window;
  const pointerId = typeof (source as PointerEvent).pointerId === 'number' ? (source as PointerEvent).pointerId : undefined;
  const touch = source.type.startsWith('touch');
  const touchIds = new Set(touch ? Array.from((source as TouchEvent).changedTouches, item => item.identifier) : []);
  const listeners: (() => void)[] = [];
  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    for (const remove of listeners) remove();
  };
  const end = () => { if (active) { dispose(); finish(); } };
  const listen = (target: EventTarget, name: string, listener: EventListener) => {
    target.addEventListener(name, listener, true);
    listeners.push(() => target.removeEventListener(name, listener, true));
  };
  const matches = (event: PointerEvent) => pointerId !== undefined ? event.pointerId === pointerId : !touch && event.pointerType === 'mouse';
  listen(view, 'blur', end);
  listen(view, 'pagehide', end);
  listen(doc, 'visibilitychange', () => { if (doc.hidden) end(); });
  listen(view, 'pointercancel', event => { if (matches(event as PointerEvent)) end(); });
  listen(view, 'lostpointercapture', event => { if (pointerId !== undefined && matches(event as PointerEvent)) end(); });
  listen(view, 'pointerdown', event => { if (matches(event as PointerEvent)) end(); });
  listen(view, 'pointermove', event => {
    const pointer = event as PointerEvent;
    // Returning after a release outside the window proves this gesture ended.
    if (matches(pointer) && pointer.buttons === 0) end();
  });
  listen(view, 'touchcancel', event => {
    if (touch && Array.from((event as TouchEvent).changedTouches).some(item => touchIds.has(item.identifier))) end();
  });
  if (pointerRelease) listen(view, 'pointerup', event => { if (matches(event as PointerEvent)) end(); });
  return dispose;
}

// Vue Flow's D3 mouse/touch drag also owns global listeners and drag state.
// Deliver its end event before releasing our flags/history; clearing booleans
// alone would let the old drag resume on the next mouse movement.
export function endCanvasDrag(source: MouseEvent | TouchEvent) {
  if (source.type.startsWith('touch')) {
    const event = new Event('touchcancel', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      changedTouches: { value: (source as TouchEvent).changedTouches },
      touches: { value: [] },
      targetTouches: { value: [] },
    });
    source.target?.dispatchEvent(event);
  } else {
    const mouse = source as MouseEvent;
    const view = mouse.view ?? window;
    view.dispatchEvent(new MouseEvent('mouseup', { view, bubbles: true, cancelable: true, button: 0, buttons: 0, clientX: mouse.clientX, clientY: mouse.clientY }));
  }
}
