import { useEffect, useRef, useState } from 'react';
import { startMic, MicUnavailableError, type Capture } from '../../features/voice/capture.js';
import { MicIcon, StopIcon } from '../Icons.js';

const LIMIT_MS = 15_000;
/** RMS above this counts as sound reaching the microphone (the worklet reports 0–1). */
const HEARD = 0.01;

type State =
  | { s: 'idle' }
  | { s: 'starting' }
  | { s: 'live' }
  | { s: 'done'; heard: boolean }
  | { s: 'error'; message: string };

/**
 * Opens the microphone locally and shows its level. Frames are dropped on arrival: nothing is recorded, sent to the
 * relay or written into any answer. Stops on Stop, on leaving the screen, or after 15 seconds.
 */
export function MicTest() {
  const [state, setState] = useState<State>({ s: 'idle' });
  const [level, setLevel] = useState(0);
  const [left, setLeft] = useState(LIMIT_MS / 1000);
  const cap = useRef<Capture | null>(null);
  const abort = useRef<AbortController | null>(null);
  const heard = useRef(false);
  const run = useRef(0);

  const stop = (finished = true) => {
    run.current++;
    abort.current?.abort();
    abort.current = null;
    cap.current?.stop();
    cap.current = null;
    setLevel(0);
    if (finished) setState({ s: 'done', heard: heard.current });
  };

  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden' && abort.current) stop();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      stop(false);
    };
  }, []);

  useEffect(() => {
    if (state.s !== 'live') return;
    const started = Date.now();
    const t = setInterval(() => {
      const remaining = Math.max(0, LIMIT_MS - (Date.now() - started));
      setLeft(Math.ceil(remaining / 1000));
      if (remaining === 0) stop();
    }, 250);
    return () => clearInterval(t);
  }, [state.s]);

  const start = async () => {
    const mine = ++run.current;
    const controller = new AbortController();
    abort.current = controller;
    heard.current = false;
    setLeft(LIMIT_MS / 1000);
    setState({ s: 'starting' });
    const failed = (error: unknown) => {
      if (mine !== run.current) return;
      stop(false);
      setState({
        s: 'error',
        message: !(error instanceof MicUnavailableError)
          ? 'The microphone couldn’t start. Try again.'
          : error.kind === 'denied'
            ? 'Microphone access is blocked. Allow it in your browser’s site settings, then try again.'
            : error.message,
      });
    };
    try {
      const c = await startMic(
        () => undefined,
        (rms) => {
          if (mine !== run.current) return;
          if (rms > HEARD) heard.current = true;
          // A perceptual curve: speech sits around 0.02–0.2 RMS, which a linear bar would barely move.
          setLevel(Math.min(1, Math.sqrt(rms) * 2.2));
        },
        controller.signal,
        failed,
      );
      if (mine !== run.current) {
        c.stop();
        return;
      }
      cap.current = c;
      setState({ s: 'live' });
    } catch (e) {
      failed(e);
    }
  };

  const live = state.s === 'live';
  return (
    <div className="mic-test">
      <div className="mic-test-row">
        {live || state.s === 'starting' ? (
          <button type="button" className="btn small" onClick={() => stop()}>
            <StopIcon size={14} />
            Stop
          </button>
        ) : (
          <button type="button" className="btn small" onClick={() => void start()}>
            <MicIcon size={16} />
            {state.s === 'idle' ? 'Test microphone' : 'Test again'}
          </button>
        )}
        <div
          className={`mic-meter${live ? ' live' : ''}`}
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
        >
          <span style={{ transform: `scaleX(${level})` }} />
        </div>
      </div>
      <p className="s-row-desc mic-test-status" role="status">
        {state.s === 'idle' && 'Checks that sound reaches Decisions. Nothing is recorded or sent.'}
        {state.s === 'starting' && 'Starting microphone…'}
        {live && `Listening · say something · stops in ${left} s`}
        {state.s === 'done' &&
          (state.heard
            ? 'Your microphone works. Nothing was recorded or sent.'
            : 'No sound reached Decisions. Check the microphone your device is using, then try again.')}
        {state.s === 'error' && state.message}
      </p>
    </div>
  );
}
