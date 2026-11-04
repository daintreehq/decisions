import type { Role } from '@daintreehq/decisions-protocol';
import { DESKTOP_ROLES, HUMAN_ROLES } from '@daintreehq/decisions-protocol';
import type { Handler } from '../room/types.js';
import * as admin from './admin.js';
import * as attachments from './attachments.js';
import * as deliveries from './deliveries.js';
import * as devices from './devices.js';
import * as events from './events.js';
import * as messages from './messages.js';
import * as pairing from './pairing.js';
import * as push from './push.js';
import * as questions from './questions.js';
import * as setup from './setup.js';
import * as snapshots from './snapshots.js';
import * as voice from './voice.js';

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  pattern: RegExp;
  auth: 'none' | 'signed';
  roles?: readonly Role[];
  handler: Handler;
}

const P = '/api/v1';
const ID = '([A-Za-z0-9_-]{8,64})';
const ANY: readonly Role[] = ['owner-desktop', 'desktop-host', 'phone', 'tablet'];
const OWNER: readonly Role[] = ['owner-desktop'];

const r = (
  method: Route['method'],
  path: string,
  auth: Route['auth'],
  handler: Handler,
  roles?: readonly Role[],
): Route => ({
  method,
  pattern: new RegExp('^' + P + path + '$'),
  auth,
  handler,
  ...(roles ? { roles } : {}),
});

export const ROUTES: Route[] = [
  r('GET', '/info', 'none', setup.info),
  r('POST', '/setup/claim', 'none', setup.claim),

  r('POST', '/pairing/invitations', 'signed', pairing.createInvitation, OWNER),
  r('POST', '/pairing/candidates', 'none', pairing.submitCandidate),
  r('GET', '/pairing/pending', 'signed', pairing.listPending, OWNER),
  r('POST', `/pairing/${ID}/approve`, 'signed', pairing.approve, OWNER),
  r('POST', `/pairing/${ID}/reject`, 'signed', pairing.reject, OWNER),
  r('GET', `/pairing/${ID}/status`, 'none', pairing.status),

  r('POST', '/socket-ticket', 'signed', devices.socketTicket, ANY),
  r('GET', '/events', 'signed', events.listEvents, ANY),

  r('POST', '/questions', 'signed', questions.createQuestion, DESKTOP_ROLES),
  r('GET', '/questions', 'signed', questions.listQuestions, ANY),
  r('GET', `/questions/${ID}`, 'signed', questions.getQuestion, ANY),
  r('DELETE', `/questions/${ID}`, 'signed', questions.deleteQuestion, OWNER),
  r('POST', `/questions/${ID}/answer`, 'signed', questions.answer, HUMAN_ROLES),
  r('POST', `/questions/${ID}/override`, 'signed', questions.override, HUMAN_ROLES),
  r('POST', `/questions/${ID}/confirm-proxy`, 'signed', questions.confirmProxy, HUMAN_ROLES),
  r('POST', `/questions/${ID}/proxy-answer`, 'signed', questions.proxyAnswer, DESKTOP_ROLES),
  r('POST', `/questions/${ID}/proxy-abstain`, 'signed', questions.proxyAbstain, DESKTOP_ROLES),
  r('POST', `/questions/${ID}/cancel`, 'signed', questions.cancel, DESKTOP_ROLES),
  r('POST', `/questions/${ID}/reopen`, 'signed', questions.reopen, OWNER),
  // Human messages need a phone or tablet and agent messages the publishing desktop; the handler checks which.
  r('POST', `/questions/${ID}/messages`, 'signed', messages.postMessage, ANY),
  r('GET', `/questions/${ID}/messages`, 'signed', messages.listMessages, ANY),
  r('PUT', `/questions/${ID}/snapshot`, 'signed', snapshots.putSnapshot, DESKTOP_ROLES),
  r('GET', `/questions/${ID}/snapshot`, 'signed', snapshots.getSnapshot, ANY),
  r('POST', `/questions/${ID}/snapshot/refresh`, 'signed', snapshots.requestRefresh, HUMAN_ROLES),

  r('POST', '/attachments/reservations', 'signed', attachments.reserve, DESKTOP_ROLES),
  r(
    'POST',
    `/questions/${ID}/images/reservations`,
    'signed',
    attachments.reservePhoneImage,
    HUMAN_ROLES,
  ),
  // Question images are completed by desktops, phone images by phones and tablets: the reservation decides.
  r('POST', `/attachments/${ID}/complete`, 'signed', attachments.complete, ANY),

  r('GET', '/devices', 'signed', devices.listDevices, ANY),
  r('GET', `/devices/${ID}/key-grants`, 'signed', devices.keyGrants, ANY),
  r('POST', '/devices/enroll-host', 'signed', devices.enrollHost, OWNER),
  r('POST', `/devices/${ID}/revoke`, 'signed', devices.revokeDevice, OWNER),
  r('POST', '/epoch/rotate', 'signed', devices.rotateEpoch, OWNER),

  r('POST', '/deliveries/received', 'signed', deliveries.received, DESKTOP_ROLES),
  r('POST', '/deliveries/terminal', 'signed', deliveries.terminal, DESKTOP_ROLES),
  r('POST', '/deliveries/failed', 'signed', deliveries.failed, DESKTOP_ROLES),
  r('POST', '/deliveries/messages', 'signed', messages.messageReceipt, DESKTOP_ROLES),

  r('GET', '/push/config', 'signed', push.pushConfig, ANY),
  r('GET', '/push/subscriptions', 'signed', push.listSubscriptions, HUMAN_ROLES),
  r('POST', '/push/subscriptions', 'signed', push.subscribe, HUMAN_ROLES),
  r('DELETE', `/push/subscriptions/${ID}`, 'signed', push.unsubscribe, HUMAN_ROLES),
  r('POST', '/push/test', 'signed', push.test, HUMAN_ROLES),
  r('GET', '/settings', 'signed', push.getSettings, ANY),
  r('PUT', '/settings', 'signed', push.putSettings, ANY),

  r('POST', '/voice/session', 'signed', voice.voiceSession, HUMAN_ROLES),

  r('GET', '/admin/diagnostics', 'signed', admin.diagnostics, OWNER),
  r('POST', '/admin/delete-data', 'signed', admin.deleteData, OWNER),
];
