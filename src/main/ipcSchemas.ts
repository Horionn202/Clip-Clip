import { z } from 'zod';
import { DURATION_PRESETS, ENGINE_IDS, MAX_CLIPS, type Settings } from '../shared/types';
import { validateVideoUrl } from '../shared/validation';
import { LAYOUT_IDS, validRect } from '../shared/layouts';
import { validateExecutablePath } from './paths';

export const idSchema = z.string().regex(/^[a-z0-9-]{8,64}$/);

export const createJobSchema = z
  .object({
    url: z.string().max(2048).transform((u, ctx) => {
      try {
        return validateVideoUrl(u);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: (e as Error).message });
        return z.NEVER;
      }
    }),
    preset: z.union(DURATION_PRESETS.map((p) => z.literal(p)) as [z.ZodLiteral<15>, z.ZodLiteral<30>, z.ZodLiteral<45>, z.ZodLiteral<60>]),
    maxClips: z.number().int().min(1).max(MAX_CLIPS),
    rightsConfirmed: z.literal(true, { message: 'Debes confirmar que tienes derechos para usar este contenido.' }),
    allowModelDownload: z.boolean().optional(),
  })
  .strict();

const exe = z.string().max(1024).transform((v, ctx) => {
  try {
    return validateExecutablePath(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

export const settingsPatchSchema = z
  .object({
    ollamaHost: z
      .string()
      .max(200)
      .regex(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/, 'Ollama debe ser local (http://127.0.0.1:11434).'),
    ollamaModel: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/, 'Nombre de modelo no válido.'),
    whisperModel: z.enum(['tiny', 'base', 'small', 'medium', 'large', 'turbo']),
    whisperLanguage: z.string().regex(/^([a-z]{2,3})?$/),
    exportDir: z.string().max(1024),
    ffmpegPath: exe,
    ffprobePath: exe,
    ytDlpPath: exe,
    whisperPath: exe,
    pythonPath: exe,
    transcriptionEngine: z.enum(['auto', ...ENGINE_IDS]),
    whisperPrecision: z.enum(['auto', 'fp16', 'fp32']),
    keepSource: z.enum(['siempre', 'hasta-exportar', 'confirmar']),
    keepTemp: z.enum(['siempre', 'tras-completar', 'tras-exportar']),
    keepTranscript: z.boolean(),
    autoCleanupDays: z.number().int().min(0).max(365),
    maxConcurrentJobs: z.number().int().min(1).max(2),
    maxSourceMinutes: z.number().int().min(1).max(600),
    maxDownloadMB: z.number().int().min(10).max(20000),
    minFreeDiskMB: z.number().int().min(100).max(500000),
    cropOffsetX: z.number().min(-1).max(1),
    defaultLayout: z.enum(['auto', ...LAYOUT_IDS]),
    subtitleFontSize: z.number().int().min(30).max(140),
    onboardingDone: z.boolean(),
  })
  .partial()
  .strict();

// exportDir sólo puede cambiarse vía diálogo nativo (no desde el renderer).
export const rendererSettingsPatchSchema = settingsPatchSchema.omit({ exportDir: true });

export const probeUrlSchema = z.string().max(2048).transform((u, ctx) => {
  try {
    return validateVideoUrl(u);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

export const normRectSchema = z
  .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
  .strict()
  .refine((r) => validRect(r), 'Rectángulo de facecam fuera de la imagen o demasiado pequeño.');

export const clipPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(100).optional(),
    hook: z.string().trim().max(200).optional(),
    start: z.number().finite().min(0).optional(),
    end: z.number().finite().min(0).optional(),
    layout: z.enum(LAYOUT_IDS).optional(),
    camRect: normRectSchema.nullable().optional(),
  })
  .strict();

export const layoutIdSchema = z.enum(LAYOUT_IDS);

export const cleanupOptionsSchema = z
  .object({ source: z.boolean(), audio: z.boolean(), frames: z.boolean(), temp: z.boolean(), transcript: z.boolean(), internalClips: z.boolean() })
  .strict();

export const previewRangeSchema = z.object({ start: z.number().finite().min(0), end: z.number().finite().min(0) }).strict();

export const renameClipSchema = z.tuple([idSchema, idSchema, z.string().trim().min(1).max(100)]);
export const modelNameSchema = z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/);

// ---- Publicar ----
export const platformSchema = z.enum(['tiktok', 'shorts', 'reels']);
export const publishStatusSchema = z.enum(['borrador', 'listo', 'programado', 'publicado', 'descartado']);
export const publishMetaSchema = z
  .object({
    title: z.string().max(300),
    description: z.string().max(6000),
    hashtags: z.array(z.string().max(100)).max(40),
  })
  .strict();
export const publishUrlSchema = z.string().trim().max(500).optional().nullable();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export const _settingsKeysCheck: (keyof Settings)[] = Object.keys(settingsPatchSchema.shape) as (keyof Settings)[];
