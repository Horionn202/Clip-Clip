import { buildCues, type Cue } from '../shared/cues';
import { SAFE_AREA } from '../shared/composition';
// Subtítulos ASS, encuadre y construcción de argumentos FFmpeg (funciones puras y testeables).

export interface Word {
  start: number;
  end: number;
  text: string;
}

/** Escapa texto para un evento Dialogue de ASS. Evita inyección de tags de override y saltos. */
export function escapeAssText(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\\/g, '⧵') // la barra invertida inicia secuencias ASS (\N, \h…): se sustituye por un símbolo similar
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\s+/g, ' ')
    .trim();
}

export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Genera un ASS con cues cortos por palabra (o los cues editados del clip), relativo al inicio del clip. */
export function buildAss(words: Word[], clipStart: number, clipEnd: number, fontSize = 72, cues?: Cue[], out: { w: number; h: number } = { w: 1080, h: 1920 }): string {
  const list = cues ?? buildCues(words, clipStart, clipEnd);
  const lines: string[] = [];
  for (const c of list) {
    const txt = escapeAssText(c.text).toUpperCase();
    if (txt && c.end > c.start) lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${txt}`);
  }
  // Margen inferior dentro del área segura (por encima de los controles de TikTok/Shorts/Reels).
  const marginV = Math.round(out.h * SAFE_AREA.bottom + 40);
  const size = Math.round(fontSize * (out.w / 1080));
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${out.w}`,
    `PlayResY: ${out.h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,${size},&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines,
    '',
  ].join('\n');
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Estrategia de encuadre. Hoy: crop central con desplazamiento horizontal.
 * Mañana: "smart crop" (detección de caras/saliencia) implementando la misma interfaz.
 */
export interface CropStrategy {
  name: string;
  compute(srcW: number, srcH: number): CropRect;
}

export function centerCrop(offsetX = 0): CropStrategy {
  return {
    name: 'center',
    compute(srcW, srcH) {
      const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2); // dimensiones
      const pos = (n: number) => Math.max(0, Math.floor(n / 2) * 2); // desplazamientos
      const targetRatio = 9 / 16;
      if (srcW / srcH > targetRatio) {
        const w = even(srcH * targetRatio);
        const free = srcW - w;
        const x = pos((free / 2) * (1 + Math.max(-1, Math.min(1, offsetX))));
        return { x: Math.min(x, srcW - w), y: 0, w, h: even(srcH) };
      }
      const h = Math.min(even(srcW / targetRatio), even(srcH));
      return { x: 0, y: pos((srcH - h) / 2), w: even(srcW), h };
    },
  };
}

/** Argumentos de FFmpeg para renderizar un clip. `assFile` es relativo al cwd (evita escapar rutas en el filtro). */
export function renderArgs(p: {
  source: string;
  start: number;
  end: number;
  crop: CropRect;
  assFile: string | null;
  output: string;
}): string[] {
  const vf = [`crop=${p.crop.w}:${p.crop.h}:${p.crop.x}:${p.crop.y}`, 'scale=1080:1920:flags=lanczos', 'setsar=1'];
  if (p.assFile) {
    if (!/^[A-Za-z0-9_.-]+\.ass$/.test(p.assFile)) throw new Error('Nombre de subtítulos no seguro');
    vf.push(`ass=${p.assFile}`);
  }
  return [
    '-hide_banner',
    '-y',
    '-ss',
    p.start.toFixed(2),
    '-to',
    p.end.toFixed(2),
    '-i',
    p.source,
    '-vf',
    vf.join(','),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '21',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    p.output,
  ];
}

/** Parsea el JSON de openai-whisper (--word_timestamps True) a palabras + segmentos. */
export function parseWhisperJson(raw: string): { words: Word[]; segments: Word[] } {
  const j = JSON.parse(raw) as { segments?: { start: number; end: number; text: string; words?: { start: number; end: number; word: string }[] }[] };
  const segments: Word[] = [];
  const words: Word[] = [];
  for (const s of j.segments ?? []) {
    segments.push({ start: s.start, end: s.end, text: (s.text ?? '').trim() });
    for (const w of s.words ?? []) {
      if (Number.isFinite(w.start) && Number.isFinite(w.end)) words.push({ start: w.start, end: w.end, text: w.word });
    }
  }
  return { words, segments };
}
