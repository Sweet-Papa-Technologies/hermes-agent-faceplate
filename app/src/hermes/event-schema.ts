// Faceplate event bus schema. See DESIGN.md §8 + DESIGN-ADDENDUM-01.md #1.
//
// Single discriminated union the renderer subscribes to. The bus is fed by:
//   1. SSE from hermes-agent (`/v1/runs/{id}/events`)
//   2. Optional shell-hook bridge on `127.0.0.1:51789`
//   3. Local audio pipeline events (TTS playback, ASR partials, wake fires)
//   4. UI events (hotkey presses, monitor cycle)

export type AgentState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export type FaceplateEventType =
  | 'state.transition'
  | 'agent.thinking'
  | 'agent.token'
  | 'agent.tool_call'
  | 'agent.response'
  | 'agent.interrupt'
  | 'agent.error'
  | 'user.input.text'
  | 'user.input.voice'
  | 'user.input.partial'
  | 'user.interrupt'
  | 'user.wake'
  | 'tts.audio.envelope'
  | 'tts.audio.start'
  | 'tts.audio.end'
  | 'system.config_changed'
  | 'system.sidecar_status';

export interface BaseEvent<T extends FaceplateEventType, P> {
  type: T;
  ts: number;
  session_id?: string;
  turn_id?: string;
  payload: P;
}

export interface StateTransition {
  from: AgentState;
  to: AgentState;
  reason?: string;
}

export interface AgentToken {
  delta: string;
  index: number;
  is_reasoning?: boolean;
}

export interface AgentToolCall {
  tool: string;
  args_preview: string;
  status: 'started' | 'completed' | 'failed';
}

export interface AgentResponse {
  text: string;
  paraphrase?: string;
  finished_reason: 'stop' | 'length' | 'tool_call' | 'interrupt';
}

export interface UserInputText {
  text: string;
  source: 'typingbar' | 'tray' | 'api';
}

export interface UserInputVoice {
  text: string;
  language?: string;
  duration_ms: number;
  confidence?: number;
}

export interface UserInputPartial {
  text: string;
  is_final: false;
}

export interface UserWake {
  model: string;
  score: number;
}

export interface TtsAudioEnvelope {
  amp: number;
  bands: [number, number, number, number];
}

// Addendum #1: TTS streams MP3/Opus over MSE; mime + format are first-class.
export type TtsMime =
  | 'audio/mpeg'
  | 'audio/mp4; codecs="opus"'
  | 'audio/webm; codecs="opus"'
  | 'audio/wav'
  | 'audio/aac';

export type TtsFormat = 'mp3' | 'opus' | 'wav' | 'aac';

export interface TtsAudioStart {
  voice: string;
  sample_rate: number;
  mime: TtsMime;
  format: TtsFormat;
}

export interface TtsAudioEnd {
  reason: 'natural' | 'interrupt' | 'error';
}

export interface AgentInterrupt {
  initiator: 'user' | 'agent' | 'system';
}

export interface AgentError {
  code: string;
  message: string;
}

export interface UserInterrupt {
  reason: 'ptt' | 'click' | 'tray' | 'hotkey';
}

export interface SystemConfigChanged {
  keys: string[];
}

export interface SystemSidecarStatus {
  up: boolean;
  build: 'cpu' | 'cpu-slim' | 'cuda';
}

export type FaceplateEvent =
  | BaseEvent<'state.transition', StateTransition>
  | BaseEvent<'agent.thinking', { tool?: string }>
  | BaseEvent<'agent.token', AgentToken>
  | BaseEvent<'agent.tool_call', AgentToolCall>
  | BaseEvent<'agent.response', AgentResponse>
  | BaseEvent<'agent.interrupt', AgentInterrupt>
  | BaseEvent<'agent.error', AgentError>
  | BaseEvent<'user.input.text', UserInputText>
  | BaseEvent<'user.input.voice', UserInputVoice>
  | BaseEvent<'user.input.partial', UserInputPartial>
  | BaseEvent<'user.interrupt', UserInterrupt>
  | BaseEvent<'user.wake', UserWake>
  | BaseEvent<'tts.audio.envelope', TtsAudioEnvelope>
  | BaseEvent<'tts.audio.start', TtsAudioStart>
  | BaseEvent<'tts.audio.end', TtsAudioEnd>
  | BaseEvent<'system.config_changed', SystemConfigChanged>
  | BaseEvent<'system.sidecar_status', SystemSidecarStatus>;

export type FaceplateEventOf<T extends FaceplateEventType> = Extract<
  FaceplateEvent,
  { type: T }
>;

// Outbound: renderer → bus → hermes/sidecar.
export type ClientCommandType =
  | 'send.text'
  | 'send.voice_blob'
  | 'cancel.current_turn'
  | 'replay.last'
  | 'tts.speak'
  | 'set.state';

export interface ClientCommand<T extends ClientCommandType = ClientCommandType, P = unknown> {
  type: T;
  payload: P;
}

export type VisemeCode = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'X';
