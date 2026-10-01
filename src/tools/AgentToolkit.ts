/**
 * AgentToolkit — MCP-compatible tool definitions for AI agents
 *
 * Defines the tools that AI agents can use to control WAVE infrastructure.
 * Compatible with Claude MCP, OpenAI function calling, and LangChain tools.
 *
 * Every tool calls one operation of the WAVE API contract (see src/routes.ts)
 * and every gateway error is thrown as a WaveToolError, never returned as a
 * result, so an agent always sees a failure as a failure.
 */

import { z } from 'zod';
import { WaveToolError, assertApiKey } from '../errors';
import { DEFAULT_BASE_URL, waveRequest } from '../http';
import type { WaveRouteName } from '../routes';

export { WaveToolError } from '../errors';

export interface AgentToolParameter {
  readonly type: string;
  readonly description: string;
  readonly required?: boolean;
  readonly enum?: readonly string[];
  readonly items?: { readonly type: string };
}

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, AgentToolParameter>;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly handler: (params: Record<string, unknown>) => Promise<unknown>;
}

const CAMERA_COMMANDS = [
  'set_zoom', 'set_focus', 'set_iris', 'set_gain', 'set_shutter', 'set_white_balance',
  'autofocus_trigger', 'recall_preset', 'save_preset', 'start_recording', 'stop_recording',
  'start_prerecord', 'set_audio_level',
] as const;

/** Fields each camera command requires, from the contract's ControlCameraRequest union. */
const CAMERA_REQUIRED: Partial<Record<(typeof CAMERA_COMMANDS)[number], readonly string[]>> = {
  set_zoom: ['value'], set_focus: ['value'], set_iris: ['value'], set_gain: ['value'],
  set_shutter: ['angle'], set_white_balance: ['temperature', 'tint'],
  recall_preset: ['presetId'], save_preset: ['name', 'slot'], set_audio_level: ['channel', 'level'],
};

const TIME_RANGE_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 } as const;

export class AgentToolkit {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = assertApiKey(config?.apiKey, 'AgentToolkit');
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  private validated(schema: z.ZodObject<z.ZodRawShape>, handler: (params: Record<string, unknown>) => Promise<unknown>) {
    return async (params: Record<string, unknown>) => {
      const parsed = schema.safeParse(params ?? {});
      if (!parsed.success) {
        throw new WaveToolError(
          `Invalid tool parameters: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
          'WAVE_ERR_VALIDATION',
          { issues: parsed.error.issues },
          'Check parameter types and required fields against the tool definition.',
        );
      }
      return handler(parsed.data as Record<string, unknown>);
    };
  }

  getTools(): AgentTool[] {
    const id = z.string().min(1);
    const createStreamSchema = z.object({
      title: z.string().min(1).max(200),
      protocol: z.enum(['webrtc', 'srt', 'rtmp', 'auto']).optional(),
      description: z.string().max(5000).optional(),
    });
    const streamIdSchema = z.object({ streamId: id });
    const clipSchema = z
      .object({ recordingId: id, startTime: z.number().min(0), endTime: z.number().positive() })
      .refine((p) => p.endTime > p.startTime, { message: 'endTime must be greater than startTime', path: ['endTime'] });
    const switchSchema = z.object({ switcherId: id, sourceId: id, transition: z.enum(['cut', 'mix', 'wipe']).optional() });
    const graphicSchema = z.object({ switcherId: id, templateId: id, data: z.record(z.string(), z.unknown()).optional() });
    const moderateSchema = z.object({ content: z.string().min(1).max(50_000), streamId: id.optional(), userId: id.optional() });
    const captionSchema = z.object({
      videoId: id,
      sourceLanguage: z.string().min(2).max(8).optional(),
      targetLanguages: z.array(z.string().min(2).max(8)).optional(),
    });
    const analyticsSchema = z.object({ streamId: id, timeRange: z.enum(['1h', '24h', '7d']).optional() });
    const highlightSchema = z.object({
      streamId: id,
      label: z.string().min(1).max(255),
      confidence: z.number().min(0).max(1).optional(),
      durationSeconds: z.number().min(0).optional(),
    });
    const cameraSchema = z
      .object({
        cameraId: id,
        type: z.enum(CAMERA_COMMANDS),
        value: z.number().optional(),
        angle: z.number().optional(),
        temperature: z.number().optional(),
        tint: z.number().optional(),
        presetId: z.string().optional(),
        name: z.string().min(1).optional(),
        slot: z.number().int().min(1).max(20).optional(),
        channel: z.number().optional(),
        level: z.number().optional(),
      })
      .superRefine((p, ctx) => {
        for (const field of CAMERA_REQUIRED[p.type] ?? []) {
          if ((p as Record<string, unknown>)[field] === undefined) {
            ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required for ${p.type}` });
          }
        }
      });

    return [
      {
        name: 'wave_create_stream',
        description: 'Create a new live stream (POST /v1/streams)',
        parameters: {
          title: { type: 'string', description: 'Stream title (1-200 chars)', required: true },
          protocol: { type: 'string', description: 'Ingest protocol', enum: ['webrtc', 'srt', 'rtmp', 'auto'] },
          description: { type: 'string', description: 'Stream description' },
        },
        schema: createStreamSchema,
        handler: this.validated(createStreamSchema, (p) => this.call('createStream', { body: p })),
      },
      {
        name: 'wave_monitor_stream',
        description: "Get a stream's current status: idle, live or ended, plus viewers (GET /v1/streams/{streamId}/status)",
        parameters: {
          streamId: { type: 'string', description: 'Stream ID', required: true },
        },
        schema: streamIdSchema,
        handler: this.validated(streamIdSchema, (p) => this.call('getStreamStatus', { params: { streamId: p.streamId as string } })),
      },
      {
        name: 'wave_create_clip',
        description: 'Cut a clip from a recording between two offsets in seconds (POST /v1/clips)',
        parameters: {
          recordingId: { type: 'string', description: 'Recording ID to clip from', required: true },
          startTime: { type: 'number', description: 'Start offset in seconds', required: true },
          endTime: { type: 'number', description: 'End offset in seconds (greater than startTime)', required: true },
        },
        schema: clipSchema,
        handler: this.validated(clipSchema, (p) =>
          this.call('createClip', {
            body: { source: p.recordingId, sourceType: 'recording_id', in: `${p.startTime}s`, out: `${p.endTime}s` },
          })),
      },
      {
        name: 'wave_switch_camera',
        description: 'Switch the live production to a different source (POST /v1/switcher, scope switcher:write)',
        parameters: {
          switcherId: { type: 'string', description: 'Switcher instance ID', required: true },
          sourceId: { type: 'string', description: 'Source to switch to', required: true },
          transition: { type: 'string', description: 'Transition type', enum: ['cut', 'mix', 'wipe'] },
        },
        schema: switchSchema,
        handler: this.validated(switchSchema, (p) => this.call('switcher', { body: { action: 'switch', ...p } })),
      },
      {
        name: 'wave_show_graphic',
        description: 'Display a graphics overlay on the live production (POST /v1/graphics-engine, scope graphics-engine:write)',
        parameters: {
          switcherId: { type: 'string', description: 'Switcher instance ID', required: true },
          templateId: { type: 'string', description: 'Graphics template ID', required: true },
          data: { type: 'object', description: 'Template data bindings' },
        },
        schema: graphicSchema,
        handler: this.validated(graphicSchema, (p) => this.call('graphicsEngine', { body: { action: 'show', ...p } })),
      },
      {
        name: 'wave_moderate_chat',
        description: 'Moderate a chat message and get a verdict: allow, flag, block or review (POST /v1/moderate)',
        parameters: {
          content: { type: 'string', description: 'The chat message text', required: true },
          streamId: { type: 'string', description: 'Stream the message was posted to' },
          userId: { type: 'string', description: 'Author of the message' },
        },
        schema: moderateSchema,
        handler: this.validated(moderateSchema, (p) =>
          this.call('moderateContent', {
            body: {
              content: p.content,
              contentType: 'chat',
              ...(p.streamId || p.userId ? { context: { streamId: p.streamId, userId: p.userId } } : {}),
            },
          })),
      },
      {
        name: 'wave_start_captions',
        description: 'Start a caption job for a video or recorded stream (POST /v1/captions)',
        parameters: {
          videoId: { type: 'string', description: 'Video ID to caption', required: true },
          sourceLanguage: { type: 'string', description: 'Spoken language code (default en)' },
          targetLanguages: { type: 'array', description: 'Extra caption languages to translate into', items: { type: 'string' } },
        },
        schema: captionSchema,
        handler: this.validated(captionSchema, (p) => this.call('createCaptionJob', { body: p })),
      },
      {
        name: 'wave_analyze_quality',
        description: 'Get viewer and quality analytics for a stream over a time range (GET /v1/streams/{streamId}/analytics)',
        parameters: {
          streamId: { type: 'string', description: 'Stream ID', required: true },
          timeRange: { type: 'string', description: 'Look-back window (default 1h)', enum: ['1h', '24h', '7d'] },
        },
        schema: analyticsSchema,
        handler: this.validated(analyticsSchema, (p) => {
          const to = new Date();
          const from = new Date(to.getTime() - TIME_RANGE_MS[(p.timeRange as keyof typeof TIME_RANGE_MS) ?? '1h']);
          return this.call('getStreamAnalytics', {
            params: { streamId: p.streamId as string },
            query: { from: from.toISOString(), to: to.toISOString() },
          });
        }),
      },
      {
        name: 'wave_mark_highlight',
        description: 'Mark a highlight on a stream for replay and clips (POST /v1/streams/{streamId}/highlights)',
        parameters: {
          streamId: { type: 'string', description: 'Stream ID', required: true },
          label: { type: 'string', description: 'Highlight label', required: true },
          confidence: { type: 'number', description: 'Confidence 0-1' },
          durationSeconds: { type: 'number', description: 'Highlight length in seconds' },
        },
        schema: highlightSchema,
        handler: this.validated(highlightSchema, (p) =>
          this.call('markStreamHighlight', {
            params: { streamId: p.streamId as string },
            body: { label: p.label, confidence: p.confidence, duration_seconds: p.durationSeconds },
          })),
      },
      {
        name: 'wave_control_camera',
        description: 'Send a control command to a camera: zoom, focus, iris, presets, recording (POST /v1/cameras/{cameraId}/control)',
        parameters: {
          cameraId: { type: 'string', description: 'Camera ID', required: true },
          type: { type: 'string', description: 'Command', required: true, enum: CAMERA_COMMANDS },
          value: { type: 'number', description: 'Value for set_zoom, set_focus, set_iris, set_gain' },
          angle: { type: 'number', description: 'Shutter angle for set_shutter' },
          temperature: { type: 'number', description: 'Kelvin for set_white_balance' },
          tint: { type: 'number', description: 'Tint for set_white_balance' },
          presetId: { type: 'string', description: 'Preset UUID for recall_preset' },
          name: { type: 'string', description: 'Preset name for save_preset' },
          slot: { type: 'number', description: 'Preset slot 1-20 for save_preset' },
          channel: { type: 'number', description: 'Audio channel for set_audio_level' },
          level: { type: 'number', description: 'Audio level for set_audio_level' },
        },
        schema: cameraSchema,
        handler: this.validated(cameraSchema, ({ cameraId, ...command }) =>
          this.call('controlCamera', { params: { cameraId: cameraId as string }, body: command })),
      },
    ];
  }

  /**
   * Find a tool by name with did-you-mean suggestions for typos.
   * Throws a WaveToolError (WAVE_ERR_UNKNOWN_TOOL) if the tool doesn't exist.
   */
  findTool(name: string): AgentTool {
    const tools = this.getTools();
    const exact = tools.find((t) => t.name === name);
    if (exact) return exact;

    const available = tools.map((t) => t.name);
    const suggestions = tools
      .map((t) => ({ name: t.name, distance: levenshtein(name, t.name) }))
      .filter((s) => s.distance <= 5)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
      .map((s) => s.name);

    const message = suggestions.length > 0
      ? `Unknown tool "${name}". Did you mean ${suggestions.map((s) => `"${s}"`).join(', ')}?`
      : `Unknown tool "${name}". Available tools: ${available.join(', ')}`;
    throw new WaveToolError(message, 'WAVE_ERR_UNKNOWN_TOOL', { requested: name, suggestions, available }, 'Check the tool name spelling.');
  }

  toMCPTools(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return this.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, val]) => [
            key,
            {
              type: val.type,
              description: val.description,
              ...(val.enum ? { enum: [...val.enum] } : {}),
              ...(val.items ? { items: val.items } : {}),
            },
          ]),
        ),
        required: Object.entries(tool.parameters).filter(([, v]) => v.required).map(([k]) => k),
      },
    }));
  }

  private call(route: WaveRouteName, req: Parameters<typeof waveRequest>[3] = {}): Promise<unknown> {
    return waveRequest(this.baseUrl, this.apiKey, route, req);
  }
}

/** Levenshtein distance for did-you-mean suggestions */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? a.length;
}
