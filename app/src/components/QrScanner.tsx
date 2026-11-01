import { useEffect, useRef, useState } from 'react';

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => Detector;
  }
}

/** Camera QR scanner: native BarcodeDetector when present, jsQR on canvas frames otherwise. */
export function QrScanner({
  onResult,
  onCancel,
  onPaste,
  onRetry,
}: {
  onResult: (text: string) => void;
  onCancel: () => void;
  /** Leave the scanner and go straight to the paste field. */
  onPaste: () => void;
  /** Start the camera again (for example after allowing it in settings). */
  onRetry: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error('This browser cannot use the camera.');
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
        const name = e instanceof Error ? e.name : '';
        setError(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'Decisions is not allowed to use the camera. Allow it in your browser settings, or paste the link instead.'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'No camera was found on this device. Paste the pairing link instead.'
              : 'The camera could not start. Paste the pairing link instead.',
        );
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scanner">
      {error ? (
        <p className="note warn" role="alert">
          {error}
        </p>
      ) : (
        <>
          <video ref={video} playsInline muted aria-label="Camera preview" />
          <p className="scanner-caption">Point the camera at the QR code on your computer.</p>
        </>
      )}
      {error ? (
        <div className="stack">
          <button type="button" className="btn primary big" onClick={onPaste}>
            Paste the link instead
          </button>
          <button type="button" className="btn" onClick={onRetry}>
            Try the camera again
          </button>
        </div>
      ) : (
        <div>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
