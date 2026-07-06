import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

export type CallMonitorEvent =
  | { type: 'status'; status: string; reason?: string; at: number }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; at: number }
  | { type: 'audio_state'; speaking: boolean; at: number };

// In-process pub/sub that lets dashboard clients watch a call's transcript
// live. Publishers (the realtime gateway) and subscribers (browser sockets)
// both key off callId; there is no persistence, so a subscriber that connects
// after an event fired simply misses it — the dashboard reflects state going
// forward, not history (call history/transcript already covers the replay case).
@Injectable()
export class CallMonitorHub {
  private readonly subscribers = new Map<string, Set<WebSocket>>();

  subscribe(callId: string, ws: WebSocket) {
    let set = this.subscribers.get(callId);
    if (!set) {
      set = new Set();
      this.subscribers.set(callId, set);
    }
    set.add(ws);
    ws.on('close', () => this.unsubscribe(callId, ws));
  }

  unsubscribe(callId: string, ws: WebSocket) {
    const set = this.subscribers.get(callId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.subscribers.delete(callId);
  }

  publish(callId: string, event: CallMonitorEvent) {
    const set = this.subscribers.get(callId);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify(event);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  // Called when a call ends so any open monitor tabs get a final status
  // event and close cleanly instead of hanging open on a dead call.
  closeAll(callId: string) {
    const set = this.subscribers.get(callId);
    if (!set) return;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'call_ended');
    }
    this.subscribers.delete(callId);
  }
}
