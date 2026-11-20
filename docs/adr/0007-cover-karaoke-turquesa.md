# ADR 0007: Facecam «cover», subtítulos en la separación e identidad Turquesa Surf

- **Estado:** Aceptada
- **Fecha:** 2026-11-20

## Contexto
El render dejaba **barras negras a los lados de la facecam**. Causa exacta: `camChain` recortaba la selección de la cámara y la encajaba con `scale=…:force_original_aspect_ratio=decrease` + `pad=…:color=black` (modo *contain*). Por ejemplo, una cámara 4:3 en el panel de 1080×704 (aspecto 1,53) se escalaba a 939×704 y se rellenaba con 70 px negros a cada lado. En 16:9 el panel de cámara mide 1920×396 (aspecto 4,85) y las barras ocupaban más de la mitad del ancho. La referencia (un Short) llena los dos paneles de lado a lado.

## Decisión
1. **Dos modos de encuadre de la cámara** (`ClipLayout.facecamFit`):
   - **`cover`** (por defecto en todas las plantillas con cámara): `coverRect` toma el mayor rectángulo con el aspecto del panel que cabe dentro de `sourceFacecamRect` (menos un 1 % de borde para no mostrar el marco ni el píxel que la detección no separa del fondo). Lo divide por el zoom, lo mueve con el encuadre horizontal y vertical sin salir de la selección y lo escala al panel: `crop` (pares) + `scale`. No hay barras, ni deformación, ni gameplay de alrededor.
   - **`contain`** («Mostrar cámara completa», avanzado): la cámara entera sobre un fondo desenfocado de la propia cámara. Nunca hay negro plano.
2. **Paneles como un Short:** cámara 40 % (768 px) arriba y gameplay 60 % (1152 px) abajo, sin separación. Con cámara detectada, la decisión automática es «Cámara arriba + gameplay abajo», esté donde esté la cámara en el original.
3. **Un solo filtergraph:** la vista previa y el render usan `layoutInputFor` → `layoutFilter`; no hay lógica duplicada.
4. **Origen y salida separados:**
   - `sourceFacecamRect`: qué se extrae del original.
   - `outputFacecamRect`, `facecamPosition` y `facecamFit`: dónde y cómo se muestra en el resultado.
   - Mover la cámara en la salida no cambia el recorte del original (hay prueba).
5. **Subtítulos:**
   - Karaoke con la palabra activa en **Turquesa Surf `#00C285`** y las demás en **Marfil Antiguo `#F2E8D5`**; Arial Black con contorno y sombra oscuros; máximo dos líneas.
   - Se centran (`\an5\pos`) en la separación cámara/gameplay en los apilados, o al 70 % en el resto, siempre dentro del área segura.
   - Ajuste manual de la posición vertical en Configuración (0 = automática).
6. **Detección:** el diagnóstico guarda además los rectángulos candidatos de cada ventana. Sin confianza suficiente: «No pudimos confirmar la cámara. Ajusta el recuadro manualmente.» y gameplay completo.
7. **Identidad visual:** tokens `--color-bg/surface/text/muted/accent/accent-hover/focus/success/danger`. Fondo Negro Piano `#0B0B0C`, texto Marfil Antiguo, acento Turquesa Surf. El texto sobre el turquesa va en Negro Piano para mantener el contraste. Rojo sólo para errores y borrados; el verde de éxito (`#8FCF6B`) no compite con el turquesa.

## Consecuencias
- Los clips ya renderizados no cambian hasta volver a renderizarlos.
- En `cover` se pierde una franja de la cámara cuando su forma no coincide con la del panel (como en cualquier Short). Si hay que verla entera, se usa «Mostrar cámara completa».
- No hay detección de rostros local: el punto focal es el centro de la selección, más el encuadre manual.
- El logo (imagen) mantiene sus colores; el resto de la interfaz usa la paleta nueva.
