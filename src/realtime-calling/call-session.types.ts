import { WebSocket } from 'ws';
import {
  GeminiLiveConfig,
  GeminiLiveSessionWrapper,
} from './gemini-live-session.wrapper';
import { ResponseSpeed } from './response-speed';

// Shared shape for both Twilio Media Streams and Plivo Audio Streams frames —
// the two protocols use the same top-level `event`/`media.payload`/`start`/
// `stop` envelope, differing mainly in the field names inside `start`
// (streamSid/callSid for Twilio, streamId/callId for Plivo).
export type TwilioFrame = {
  event?: string;
  streamSid?: string;
  start?: {
    streamSid?: string;
    callSid?: string;
    streamId?: string;
    callId?: string;
    customParameters?: Record<string, string>;
  };
  media?: { payload?: string };
  stop?: Record<string, unknown>;
};

export type CallProvider = 'twilio' | 'plivo';

export type ActiveCallSession = {
  callId: string;
  /** Signed token from the stream URL query, checked when the start frame names the call. */
  streamToken?: string;
  provider: CallProvider;
  streamSid?: string;
  providerCallSid?: string;
  call?: any;
  campaign?: any;
  contact?: any;
  gemini?: GeminiLiveSessionWrapper;
  userTurns: number;
  assistantTurns: number;
  pendingHangup: boolean;
  endCallReason?: string;
  completed: boolean;
  preventInterruption: boolean;
  assistantAudioActive: boolean;
  outboundAudioLogged: boolean;
  responseSpeed: ResponseSpeed;
  noiseGateDbfs: number;
  noiseSuppressedFrames: number;
  manualActivityActive: boolean;
  manualAudioMs: number;
  manualLastSpeechAudioMs?: number;
  setupStartedAt?: number;
  setupCompletedAt?: number;
  lastUserTranscriptAt?: number;
  awaitingModelAudioAfterUser: boolean;
  scriptWriteTail: Promise<void>;
  speechActive: boolean;
  speechDetectionMs: number;
  speechBuffer: Buffer[];
  noiseFloorDbfs: number;
  ws?: WebSocket;
  geminiConfig?: GeminiLiveConfig;
  preparePromise?: Promise<void>;
  reconnectAttempts: number;
  callActive: boolean;
  cleanedUp: boolean;
  lastActivityAt: number;
  inactivityStrikes: number;
  inactivityTimer?: NodeJS.Timeout;
  maxCallTimer?: NodeJS.Timeout;
  // Greeting can be generated before the Twilio start frame arrives; audio is
  // held here (already transcoded to 8k μ-law base64) until streamSid is known.
  startSignalSent: boolean;
  pendingOutboundAudio: string[];
  pendingOutboundBytes: number;
  // Latest Gemini Live session-resumption handle, so a mid-call reconnect
  // restores the conversation instead of starting a blank session.
  resumeHandle?: string;
};
