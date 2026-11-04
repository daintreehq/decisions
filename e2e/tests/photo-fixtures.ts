import type { Page } from 'playwright-core';

/**
 * Photos for the end-to-end tests and captures, drawn in the browser's own canvas (so they are real JPEGs and PNGs the
 * page can decode) at camera-like sizes: a whiteboard, the back of a router, a printed proof and a screenshot. Each
 * comes back as a file payload for a file chooser.
 */
export interface PhotoFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export async function drawPhotos(page: Page): Promise<Record<string, PhotoFile>> {
  const drawn = await page.evaluate(async () => {
    const make = (
      w: number,
      h: number,
      paint: (c: CanvasRenderingContext2D) => void,
      type: 'image/jpeg' | 'image/png',
    ) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const c = canvas.getContext('2d')!;
      paint(c);
      return canvas.toDataURL(type, 0.92).split(',')[1]!;
    };
    const noise = (c: CanvasRenderingContext2D, w: number, h: number, a: number) => {
      for (let i = 0; i < 2400; i++) {
        c.fillStyle = `rgba(0,0,0,${Math.random() * a})`;
        c.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
    };
    const whiteboard = make(
      2400,
      1800,
      (c) => {
        const g = c.createLinearGradient(0, 0, 2400, 1800);
        g.addColorStop(0, '#f4f2ee');
        g.addColorStop(1, '#d9d6cf');
        c.fillStyle = g;
        c.fillRect(0, 0, 2400, 1800);
        c.fillStyle = '#9a958c';
        c.fillRect(0, 1640, 2400, 160);
        c.lineWidth = 14;
        c.lineCap = 'round';
        c.strokeStyle = '#1f4f9c';
        c.font = 'bold 120px "Marker Felt", "Comic Sans MS", cursive';
        c.fillStyle = '#1f4f9c';
        c.fillText('Sidebar', 220, 320);
        c.strokeRect(200, 420, 640, 360);
        c.fillText('Canopy', 300, 640);
        c.beginPath();
        c.moveTo(900, 600);
        c.lineTo(1380, 600);
        c.lineTo(1320, 540);
        c.moveTo(1380, 600);
        c.lineTo(1320, 660);
        c.stroke();
        c.strokeStyle = '#b3261e';
        c.fillStyle = '#b3261e';
        c.strokeRect(1460, 420, 640, 360);
        c.fillText('Inbox', 1580, 640);
        c.font = '90px "Marker Felt", "Comic Sans MS", cursive';
        c.fillStyle = '#2b2b2b';
        c.fillText('/canopy → /inbox (301)', 260, 1080);
        c.fillText('keep old icon for now', 260, 1240);
        noise(c, 2400, 1800, 0.05);
      },
      'image/jpeg',
    );
    const router = make(
      1800,
      2400,
      (c) => {
        c.fillStyle = '#2d2f33';
        c.fillRect(0, 0, 1800, 2400);
        c.fillStyle = '#1b1c1f';
        c.fillRect(160, 260, 1480, 1880);
        c.fillStyle = '#e9e7e1';
        c.fillRect(380, 700, 1040, 760);
        c.fillStyle = '#111';
        c.font = 'bold 84px Helvetica, Arial, sans-serif';
        c.fillText('NETGEAR', 460, 830);
        c.font = '64px Helvetica, Arial, sans-serif';
        c.fillText('Model: RAX50v2', 460, 960);
        c.fillText('S/N: 6LA19B7Q01842', 460, 1060);
        c.fillText('MAC: 94:A6:7E:2B:11:C4', 460, 1160);
        c.fillText('12V ⎓ 2.5A', 460, 1260);
        for (let i = 0; i < 4; i++) {
          c.fillStyle = '#f2c94c';
          c.fillRect(420 + i * 260, 1700, 180, 120);
        }
        noise(c, 1800, 2400, 0.08);
      },
      'image/jpeg',
    );
    const proof = make(
      2000,
      1500,
      (c) => {
        c.fillStyle = '#fbfaf6';
        c.fillRect(0, 0, 2000, 1500);
        c.fillStyle = '#2a2a2a';
        c.font = 'bold 72px Georgia, serif';
        c.fillText('Release notes 0.4', 160, 220);
        c.font = '44px Georgia, serif';
        const lines = [
          'Decisions now answers from one composer: tap',
          'or hold to talk, and send follow-ups after an',
          'answer. Attach photos from the composer: take',
          'one with the camera or choose from the library.',
        ];
        lines.forEach((l, i) => c.fillText(l, 160, 360 + i * 80));
        c.strokeStyle = '#c0392b';
        c.lineWidth = 8;
        c.beginPath();
        c.ellipse(860, 594, 330, 70, 0, 0, Math.PI * 2);
        c.stroke();
        c.font = 'italic 52px Georgia, serif';
        c.fillStyle = '#c0392b';
        c.fillText('“taking” not “take”?', 1080, 760);
        noise(c, 2000, 1500, 0.04);
      },
      'image/jpeg',
    );
    const screenshot = make(
      1170,
      2532,
      (c) => {
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, 1170, 2532);
        c.fillStyle = '#f2f2f7';
        c.fillRect(0, 0, 1170, 280);
        c.fillStyle = '#000';
        c.font = 'bold 64px -apple-system, Helvetica, sans-serif';
        c.fillText('Checkout', 60, 220);
        c.fillStyle = '#ffe9e7';
        c.fillRect(60, 420, 1050, 360);
        c.fillStyle = '#b3261e';
        c.font = 'bold 52px -apple-system, Helvetica, sans-serif';
        c.fillText('Payment failed', 110, 530);
        c.font = '44px -apple-system, Helvetica, sans-serif';
        c.fillText('Error 402: card_declined', 110, 620);
        c.fillText('Request id req_8Hk2Qa', 110, 700);
      },
      'image/png',
    );
    return { whiteboard, router, proof, screenshot };
  });
  const file = (name: string, mimeType: string, b64: string): PhotoFile => ({
    name,
    mimeType,
    buffer: Buffer.from(b64, 'base64'),
  });
  return {
    whiteboard: file('IMG_4012.JPG', 'image/jpeg', drawn.whiteboard),
    router: file('IMG_4013.JPG', 'image/jpeg', drawn.router),
    proof: file('IMG_4014.JPG', 'image/jpeg', drawn.proof),
    screenshot: file('Screenshot 2026-11-04.png', 'image/png', drawn.screenshot),
  };
}

/** A fixed location the test can look for: the Houses of Parliament, as a camera would record it. */
export const GPS_MARKER = 'DAINTREE-GPS-51.4995N';

/**
 * The same JPEG with an EXIF segment (APP1) carrying a GPS position, as a phone camera writes one: IFD0 points at a
 * GPS IFD holding the latitude, its reference and an ASCII processing-method tag with a marker string to search for.
 */
export function withGpsExif(jpeg: Buffer): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  const marker = Buffer.from(`${GPS_MARKER}\0`, 'ascii');
  const entries = 3;
  const gpsIfd = 8 + 2 + 12 + 4; // after IFD0's one entry
  const gpsData = gpsIfd + 2 + entries * 12 + 4;
  const latAt = gpsData;
  const markerAt = latAt + 24;
  const tiff = Buffer.alloc(markerAt + marker.length);
  tiff.write('MM', 0, 'ascii');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  // IFD0: GPSInfo -> the GPS IFD.
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8825, 10);
  tiff.writeUInt16BE(4, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(gpsIfd, 18);
  tiff.writeUInt32BE(0, 22);
  // GPS IFD: LatitudeRef "N", Latitude (51/1, 29/1, 5820/100), ProcessingMethod (the marker).
  let at = gpsIfd;
  tiff.writeUInt16BE(entries, at);
  at += 2;
  tiff.writeUInt16BE(0x0001, at);
  tiff.writeUInt16BE(2, at + 2);
  tiff.writeUInt32BE(2, at + 4);
  tiff.write('N\0', at + 8, 'ascii');
  at += 12;
  tiff.writeUInt16BE(0x0002, at);
  tiff.writeUInt16BE(5, at + 2);
  tiff.writeUInt32BE(3, at + 4);
  tiff.writeUInt32BE(latAt, at + 8);
  at += 12;
  tiff.writeUInt16BE(0x001b, at);
  tiff.writeUInt16BE(7, at + 2);
  tiff.writeUInt32BE(marker.length, at + 4);
  tiff.writeUInt32BE(markerAt, at + 8);
  at += 12;
  tiff.writeUInt32BE(0, at);
  [51, 1, 29, 1, 5820, 100].forEach((v, i) => tiff.writeUInt32BE(v, latAt + i * 4));
  marker.copy(tiff, markerAt);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

/** Whether a JPEG still carries an EXIF segment or the GPS marker anywhere in its bytes. */
export function hasExif(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes);
  return b.includes(Buffer.from('Exif\0\0', 'binary')) || b.includes(Buffer.from(GPS_MARKER));
}
