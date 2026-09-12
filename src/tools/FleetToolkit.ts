/**
 * FleetToolkit — the shipped WAVE product spokes as agent tools: voice, transcribe, captions.
 *
 * GROUNDING: every path and parameter below comes from the spokes' OWN routers at `origin/main`, not
 * from `api-spec/openapi.yaml`. The spec over-declares this surface (`/voice/generate`,
 * `/voice/voices`, `/transcribe/{id}`, `/captions/{jobId}/download`, …) and none of those exist —
 * each spoke owns its whole `/v1` namespace with an exact-match router that 404s anything else, and
 * the gateway forwards `/v1/<product>` verbatim with no path rewriting. Filed as wave-av/api-spec#33.
 * The three real endpoints are:
 *
 *   POST /v1/voice        wave-voice-edge      → audio bytes (audio/mpeg)
 *   POST /v1/transcribe   wave-transcribe-edge → JSON transcript
 *   POST /v1/captions     wave-captions-edge   → a caption FILE (WebVTT / SubRip) or JSON cues
 *
 * AUDIO INPUT IS BY URL. Both STT spokes accept audio as a raw request body or via a `?url=` they
 * fetch server-side. Tool arguments are structured data, so the URL path is the only workable one —
 * and it is how an agent already holds media. The URL is validated as well-formed here; SSRF
 * containment is the spoke's responsibility, since it is the party that performs the fetch.
 */

import { z } from 'zod';
import {
  assertOk,
  readUsage,
  toMCPToolDefs,
  validated,
  type AgentTool,
  type MCPToolDef,
  type WaveUsage,
} from './shared';

export interface FleetToolkitConfig {
  /** WAVE API key. Read it from the environment — never hardcode it (`.wave-rules/no-hardcoded-keys.md`). */
  apiKey: string;
  /** Gateway front door. Defaults to the production gateway. */
  baseUrl?: string;
}

/** STT engines both the transcribe and captions spokes accept. `auto` resolves to a concrete engine
 *  by payload size inside the spoke. */
const ENGINE = z.enum(['auto', 'whisper', 'deepgram', 'elevenlabs']);

/**
 * The result of a speech-synthesis call.
 *
 * `audio` holds the real bytes, because discarding a response body in an SDK is lossy and the caller
 * cannot recover it. But `toJSON()` deliberately omits them: agent-framework adapters routinely
 * `JSON.stringify` a tool result into a model's context, and a megabyte of serialised byte array
 * there is useless to a model that cannot listen to it. So code gets the audio and a serialiser gets
 * a receipt — no caller has to choose.
 */
export class VoiceResult {
  readonly audio: Uint8Array;
  readonly contentType: string;
  readonly usage: WaveUsage;

  constructor(audio: Uint8Array, contentType: string, usage: WaveUsage) {
    this.audio = audio;
    this.contentType = contentType;
    this.usage = usage;
  }

  get byteLength(): number {
    return this.audio.byteLength;
  }

  toJSON(): Record<string, unknown> {
    return {
      contentType: this.contentType,
      byteLength: this.byteLength,
      usage: this.usage,
      audio: '<omitted — read result.audio for the bytes>',
    };
  }
}

export interface TranscriptResult {
  readonly transcript: unknown;
  readonly usage: WaveUsage;
}

export interface CaptionResult {
  /** The caption file verbatim (WebVTT / SubRip text, or a JSON cue document as text). */
  readonly captions: string;
  readonly contentType: string;
  readonly usage: WaveUsage;
}

/** Build the query string from the knobs the STT spokes actually read. */
function audioQuery(args: {
  url: string;
  engine?: string;
  language?: string;
  diarize?: boolean;
  format?: string;
}): string {
  const p = new URLSearchParams({ url: args.url });
  if (args.engine) p.set('engine', args.engine);
  if (args.language) p.set('language', args.language);
  if (args.diarize) p.set('diarize', 'true');
  if (args.format) p.set('format', args.format);
  return p.toString();
}

export class FleetToolkit {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: FleetToolkitConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.wave.online';
  }

  /**
   * POST to a gateway-fronted spoke.
   *
   * Content-Type is the CALLER's to set, not this method's: the STT spokes distinguish a
   * query-parameterised request from a raw-media body by content type, so forcing
   * `application/json` on every call (as `AgentToolkit.call` does) misroutes them.
   */
  private async post(tool: string, path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, ...init?.headers },
    });
    await assertOk(tool, response);
    return response;
  }

  /** Synthesize speech. Returns the audio bytes plus what the call was billed. */
  async speak(params: { text: string; voiceId?: string; modelId?: string }): Promise<VoiceResult> {
    const body: Record<string, string> = { text: params.text };
    if (params.voiceId) body.voiceId = params.voiceId;
    if (params.modelId) body.modelId = params.modelId;

    const response = await this.post('wave_speak', '/v1/voice', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const audio = new Uint8Array(await response.arrayBuffer());
    return new VoiceResult(audio, response.headers.get('content-type') ?? 'audio/mpeg', readUsage(response));
  }

  /** Transcribe audio hosted at a publicly reachable URL. */
  async transcribe(params: {
    url: string;
    engine?: string;
    language?: string;
    diarize?: boolean;
  }): Promise<TranscriptResult> {
    const response = await this.post('wave_transcribe', `/v1/transcribe?${audioQuery(params)}`);
    const usage = readUsage(response);
    return { transcript: await response.json(), usage };
  }

  /** Generate a caption file from audio hosted at a publicly reachable URL. */
  async caption(params: {
    url: string;
    format?: string;
    engine?: string;
    language?: string;
  }): Promise<CaptionResult> {
    const response = await this.post('wave_caption', `/v1/captions?${audioQuery(params)}`);
    const usage = readUsage(response);
    return {
      captions: await response.text(),
      contentType: response.headers.get('content-type') ?? 'text/vtt',
      usage,
    };
  }

  getTools(): AgentTool[] {
    const speakSchema = z.object({
      text: z.string().min(1),
      voiceId: z.string().optional(),
      modelId: z.string().optional(),
    });
    const transcribeSchema = z.object({
      url: z.url(),
      engine: ENGINE.optional(),
      language: z.string().optional(),
      diarize: z.boolean().optional(),
    });
    const captionSchema = z.object({
      url: z.url(),
      format: z.enum(['vtt', 'srt', 'json']).optional(),
      engine: ENGINE.optional(),
      language: z.string().optional(),
    });

    return [
      {
        name: 'wave_speak',
        description:
          'Synthesize speech from text with WAVE Voice. Returns the audio bytes plus the billed usage; ' +
          'serialising the result yields a receipt rather than the bytes.',
        parameters: {
          text: { type: 'string', description: 'Text to synthesize', required: true },
          voiceId: { type: 'string', description: 'Voice to use (defaults to the WAVE default voice)' },
          modelId: { type: 'string', description: 'TTS model id (defaults to the multilingual model)' },
        },
        schema: speakSchema,
        handler: validated(speakSchema, (params) =>
          this.speak(params as { text: string; voiceId?: string; modelId?: string }),
        ),
      },
      {
        name: 'wave_transcribe',
        description:
          'Transcribe audio from a publicly reachable URL with WAVE Transcribe. The spoke fetches the ' +
          'URL itself, so it must be reachable from the public internet.',
        parameters: {
          url: { type: 'string', description: 'Publicly reachable URL of the audio', required: true },
          engine: { type: 'string', description: 'STT engine: auto, whisper, deepgram, elevenlabs' },
          language: { type: 'string', description: "BCP-47 language hint, e.g. 'en'" },
          diarize: { type: 'boolean', description: 'Label distinct speakers' },
        },
        schema: transcribeSchema,
        handler: validated(transcribeSchema, (params) =>
          this.transcribe(params as { url: string; engine?: string; language?: string; diarize?: boolean }),
        ),
      },
      {
        name: 'wave_caption',
        description:
          'Generate a caption file (WebVTT, SubRip, or JSON cues) from audio at a publicly reachable ' +
          'URL with WAVE Captions.',
        parameters: {
          url: { type: 'string', description: 'Publicly reachable URL of the audio', required: true },
          format: { type: 'string', description: 'Caption format: vtt, srt, json' },
          engine: { type: 'string', description: 'STT engine: auto, whisper, deepgram, elevenlabs' },
          language: { type: 'string', description: "BCP-47 language hint, e.g. 'en'" },
        },
        schema: captionSchema,
        handler: validated(captionSchema, (params) =>
          this.caption(params as { url: string; format?: string; engine?: string; language?: string }),
        ),
      },
    ];
  }

  toMCPTools(): MCPToolDef[] {
    return toMCPToolDefs(this.getTools());
  }
}
