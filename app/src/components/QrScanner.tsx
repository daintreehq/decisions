import { useEffect, useRef, useState } from 'react';
import { LinkIcon, RefreshIcon } from './Icons.js';
import { Callout } from './settings/ui.js';

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => Detector;
  }
}

/** A camera failure. `retry` is false when trying again cannot help (no camera, no camera API). */
type CameraProblem = { title: string; body: string; retry: boolean };

/** What the camera is doing, for the page's one live region. */
export type ScanStatus = 'starting' | 'live';

/** Camera QR scanner: native BarcodeDetector when present, jsQR on canvas frames otherwise. */
export function QrScanner({
  onResult,
  onCancel,
  onPaste,
  onRetry,
  onStatus,
}: {
  onResult: (text: string) => void;
  onCancel: () => void;
  /** Leave the scanner and go straight to the paste field. */
  onPaste: () => void;
  /** Start the camera again (for example after allowing it in settings). */
  onRetry: () => void;
  /** Told when the camera starts and when it is live, so the page can announce it. */
  onStatus?: (status: ScanStatus | null) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<CameraProblem | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onStatus?.('starting');
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw Object.assign(new Error('no camera api'), { name: 'NotSupportedError' });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        const v = video.current;
        if (!v || stopped) {
          // Cancelled while the camera was starting: release it at once.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        v.srcObject = stream;
        await v.play();
        setLive(true);
        onStatus?.('live');
        const detector = window.BarcodeDetector
          ? new window.BarcodeDetector({ formats: ['qr_code'] })
          : null;
        const jsQR = detector ? null : (await import('jsqr')).default;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = async () => {
          if (stopped) return;
          try {
            if (v.readyState >= 2) {
              let text: string | null = null;
              if (detector) {
                text = (await detector.detect(v))[0]?.rawValue ?? null;
              } else if (ctx && jsQR) {
                canvas.width = v.videoWidth;
                canvas.height = v.videoHeight;
                ctx.drawImage(v, 0, 0);
                const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                text = jsQR(img.data, img.width, img.height)?.data ?? null;
              }
              if (text) {
                stopped = true;
                onResult(text);
                return;
              }
            }
          } catch {
            /* a bad frame is not fatal */
          }
          timer = setTimeout(tick, 200);
        };
        void tick();
      } catch (e) {
        stream?.getTracks().forEach((t) => t.stop());
        if (stopped) return;
        onStatus?.(null);
        const name = e instanceof Error ? e.name : '';
        setError(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? {
                title: 'Camera access is blocked',
                body: 'Allow the camera for this site in your browser’s settings, then try again. Or paste the pairing link instead.',
                retry: true,
              }
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? {
                  title: 'No camera found',
                  body: 'This device has no camera Decisions can use. Paste the pairing link instead.',
                  retry: false,
                }
              : name === 'NotSupportedError'
                ? {
                    title: 'This browser can’t use the camera',
                    body: 'Paste the pairing link instead.',
                    retry: false,
                  }
                : {
                    title: 'The camera couldn’t start',
                    body: 'Another app may be using it. Try again, or paste the pairing link instead.',
                    retry: true,
                  },
        );
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      onStatus?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="scanner">
        <Callout tone="warn" role="alert" title={error.title}>
          {error.body}
        </Callout>
        <div className="onb-actions">
          <button type="button" className="btn primary big" onClick={onPaste}>
            <LinkIcon size={20} />
            Paste pairing link
          </button>
          {error.retry && (
            <button type="button" className="btn big" onClick={onRetry}>
              <RefreshIcon size={20} />
              Try the camera again
            </button>
          )}
          <button type="button" className="btn ghost big" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="scanner">
      <div className={`scanner-frame${live ? ' live' : ''}`}>
        <video ref={video} playsInline muted aria-label="Camera preview" />
        <span className="scanner-target" aria-hidden="true" />
        {!live && (
          <span className="scanner-starting">
            <span className="spinner" aria-hidden="true" />
            Starting camera…
          </span>
        )}
      </div>
      <p className="scanner-caption">Point the camera at the code on your computer’s screen.</p>
      <div className="onb-actions">
        <button type="button" className="btn big" onClick={onPaste}>
          <LinkIcon size={20} />
          Paste pairing link
        </button>
        <button type="button" className="btn ghost big" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
