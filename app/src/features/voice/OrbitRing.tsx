import { useEffect, useRef } from 'react';

/**
 * Daintree's dictation orbit (VoiceInputButton.tsx), ported at touch size: an accent arc whose speed, brightness and
 * thickness follow the voice, driven by requestAnimationFrame from a level read per frame (never a React render).
 * Reduced motion holds the arc still at its resting thickness while its brightness still follows the voice. While the
 * machine is still getting ready (microphone starting, last words finishing) a neutral arc spins instead.
 */

// Flywheel, double-smoothed for S-curve easing (Daintree's constants).
const IDLE_SPEED = 72; // deg/s, one revolution per 5 s
const ACTIVE_SPEED = 288; // deg/s, one revolution per 1.25 s
const TAU_ATTACK = 0.22;
const TAU_RELEASE = 0.5;
const AUDIO_SMOOTH = 0.15;
const SCALE_MIN = 0.94;
const SCALE_MAX = 1.0;
const MIN_DOT_OPACITY = 0.55;

const INK = 'var(--accent)';
const tint = (a: number) => `color-mix(in oklab, ${INK} ${(a * 100).toFixed(1)}%, transparent)`;

const reduced = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function OrbitRing({ mode, level }: { mode: 'orbit' | 'wait' | null; level: () => number }) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const arcRef = useRef<HTMLSpanElement>(null);
  const coreRef = useRef<HTMLSpanElement>(null);
  const haloRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    if (mode !== 'orbit') return;
    let raf = 0;
    let last = performance.now();
    let angle = 0;
    let v1 = IDLE_SPEED;
    let velocity = IDLE_SPEED;
    let smooth = 0;
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      smooth += (levelRef.current() - smooth) * AUDIO_SMOOTH;
      const lv = Math.pow(Math.max(0, Math.min(1, smooth)), 1.5);
      const target = IDLE_SPEED + lv * (ACTIVE_SPEED - IDLE_SPEED);
      const tau = target > velocity ? TAU_ATTACK : TAU_RELEASE;
      const alpha = 1 - Math.exp(-dt / tau);
      v1 += (target - v1) * alpha;
      velocity += (v1 - velocity) * alpha;
      angle = (angle + velocity * dt) % 360;
      const opacity = 0.45 + lv * 0.55;
      const scale = SCALE_MIN + lv * (SCALE_MAX - SCALE_MIN);
      const still = reduced();
      if (wrapRef.current)
        wrapRef.current.style.transform = still
          ? `rotate(0deg) scale(${SCALE_MIN})`
          : `rotate(${angle.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
      if (arcRef.current)
        arcRef.current.style.background = `conic-gradient(from 0deg, transparent 200deg, ${tint(
          opacity * 0.05,
        )} 248deg, ${tint(opacity * 0.18)} 292deg, ${tint(opacity * 0.42)} 326deg, ${tint(
          opacity * 0.82,
        )} 348deg, ${tint(opacity)} 355deg, transparent 360deg)`;
      if (coreRef.current)
        coreRef.current.style.opacity = String(MIN_DOT_OPACITY + lv * (1 - MIN_DOT_OPACITY));
      if (haloRef.current) {
        haloRef.current.style.boxShadow = `0 0 ${6 + lv * 6}px ${tint(0.18 + lv * 0.22)}`;
        haloRef.current.style.opacity = String(0.5 + lv * 0.5);
      }
      if (trackRef.current) trackRef.current.style.opacity = String(0.12 + lv * 0.06);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  if (mode === 'wait')
    return (
      <span className="orbit" aria-hidden="true">
        <span className="orbit-band orbit-wait-track" />
        <span className="orbit-band orbit-wait" data-ring="wait" />
      </span>
    );
  if (mode !== 'orbit') return null;
  return (
    <span className="orbit" aria-hidden="true">
      <span ref={trackRef} className="orbit-band orbit-track" />
      <span ref={wrapRef} className="orbit-spin" data-ring="orbit">
        <span ref={arcRef} className="orbit-band" />
        <span ref={haloRef} className="orbit-dot orbit-halo" />
        <span ref={coreRef} className="orbit-dot orbit-core" />
      </span>
    </span>
  );
}
