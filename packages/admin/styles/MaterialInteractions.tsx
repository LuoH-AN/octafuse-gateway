'use client';

import { useEffect } from 'react';
import { useLinkStatus } from 'next/link';

/** Real navigation progress, rendered inside a Next Link. */
export function MaterialLinkFeedback() {
  const { pending } = useLinkStatus();
  return pending ? <span className="md-navigation-progress" aria-hidden /> : null;
}

/** Decorative press feedback; native clicks, focus, scrolling and key handling stay intact. */
export default function MaterialInteractions() {
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const waves = new Set<() => void>();
    const pointers = new Map<number, { x: number; y: number; cancel: () => void }>();
    const hosts = new Map<HTMLElement, { count: number; position: string }>();

    function ripple(target: EventTarget | null, x?: number, y?: number) {
      if (reducedMotion.matches || !(target instanceof Element)) return;
      const control = target.closest<HTMLElement>('button, .md-sidebar nav a, summary');
      if (!control?.closest('.admin-material') || control.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]')) return;
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.height > 100) return;

      let host = hosts.get(control);
      if (!host) {
        host = { count: 0, position: control.style.position };
        hosts.set(control, host);
        if (getComputedStyle(control).position === 'static') control.style.position = 'relative';
      }
      host.count++;
      const layer = document.createElement('span');
      layer.className = 'md-ripple-layer';
      layer.setAttribute('aria-hidden', 'true');
      const ink = document.createElement('span');
      ink.className = 'md-ripple-ink';
      const left = x === undefined ? rect.width / 2 : x - rect.left;
      const top = y === undefined ? rect.height / 2 : y - rect.top;
      const size = 2 * Math.hypot(Math.max(left, rect.width - left), Math.max(top, rect.height - top));
      Object.assign(ink.style, { width: `${size}px`, height: `${size}px`, left: `${left - size / 2}px`, top: `${top - size / 2}px` });
      layer.appendChild(ink);
      control.appendChild(layer);
      const animation = ink.animate([
        { transform: 'scale(0.12)', opacity: 0.16 },
        { transform: 'scale(0.8)', opacity: 0.1, offset: 0.55 },
        { transform: 'scale(1)', opacity: 0 },
      ], { duration: 420, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
      let removed = false;
      const cancel = () => {
        if (removed) return;
        removed = true;
        animation.cancel();
        layer.remove();
        waves.delete(cancel);
        for (const [id, pointer] of pointers) if (pointer.cancel === cancel) pointers.delete(id);
        if (--host.count === 0) {
          if (control.style.position === 'relative') control.style.position = host.position;
          hosts.delete(control);
        }
      };
      waves.add(cancel);
      animation.onfinish = cancel;
      return cancel;
    }

    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const cancel = ripple(event.target, event.clientX, event.clientY);
      if (cancel) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, cancel });
    };
    const pointerMove = (event: PointerEvent) => {
      const pointer = pointers.get(event.pointerId);
      if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10) pointer.cancel();
    };
    const pointerUp = (event: PointerEvent) => pointers.delete(event.pointerId);
    const pointerCancel = (event: PointerEvent) => pointers.get(event.pointerId)?.cancel();
    const keyDown = (event: KeyboardEvent) => {
      if (!event.repeat && (event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.matches('button, summary, .md-sidebar nav a')) {
        if (event.key === ' ' && event.target.matches('a')) return;
        ripple(event.target);
      }
    };
    const clear = () => { for (const cancel of waves) cancel(); };
    document.addEventListener('pointerdown', pointerDown, { passive: true });
    document.addEventListener('pointermove', pointerMove, { passive: true });
    document.addEventListener('pointerup', pointerUp, { passive: true });
    document.addEventListener('pointercancel', pointerCancel, { passive: true });
    document.addEventListener('keydown', keyDown);
    document.addEventListener('scroll', clear, { passive: true, capture: true });
    window.addEventListener('blur', clear);
    reducedMotion.addEventListener('change', clear);
    return () => {
      clear();
      document.removeEventListener('pointerdown', pointerDown);
      document.removeEventListener('pointermove', pointerMove);
      document.removeEventListener('pointerup', pointerUp);
      document.removeEventListener('pointercancel', pointerCancel);
      document.removeEventListener('keydown', keyDown);
      document.removeEventListener('scroll', clear, true);
      window.removeEventListener('blur', clear);
      reducedMotion.removeEventListener('change', clear);
    };
  }, []);
  return null;
}
