# Pruebas manuales

Guía corta para comprobar las funciones que dependen de vídeo real. Los tests automáticos (`npm test`) cubren la lógica, pero no estas pruebas.

> **Datos aislados (sólo desarrollo).** Para no tocar `%APPDATA%\Clip Clip`, arranca con una carpeta de datos de prueba:
> `$env:CLIP_CLIP_DATA_DIR = "C:\ClipClipPruebas"; npm run dev`.
> La app instalada ignora esta variable.

## 1. Vídeo normal (sin facecam)
1. Inicio → pega la URL de un vídeo autorizado de 3–10 min → clips de 30 s → Crear.
2. En **Trabajos** deben verse las 9 tarjetas: la actual en azul/violeta con porcentaje y tiempo, las anteriores en verde y las siguientes en gris. Ninguna en rojo salvo que falle.
3. En la tarjeta «Transcribiendo» deben aparecer los minutos procesados, el modelo y GPU/CPU.
4. En **Resultados**, abre un clip con **Editar clip → Subtítulos**. Reproduce y comprueba que cada frase aparece cuando se dice. Divide un cue, cambia un texto, **Guardar cambios** y **Renderizar este clip**: sólo cambia ese clip.

## 2. Vídeo de gameplay con cámara abajo a la derecha
1. Crea un trabajo con un vídeo de gameplay con facecam rectangular en la esquina inferior derecha.
2. Con «Plantilla por defecto: automática», el clip debe salir como «Gameplay arriba + facecam abajo», con la cámara entera (sin cortar la cara).
3. Si la detección falla, el clip debe mostrar **«No se pudo confirmar una facecam. Ajústala manualmente.»** y usar «Sin facecam: sólo gameplay».
4. Editar clip → Composición:
   - elige «Gameplay arriba + cámara abajo»;
   - arrastra el recuadro hasta la cámara y redimensiónalo desde la esquina (también con flechas y Mayús+flechas);
   - pulsa **Vista previa rápida**.
5. Cambia a «Personalizado» y coloca la caja en la salida, dentro del área segura punteada. Prueba 1:1 y 16:9.
6. **Restablecer detección automática** vuelve a lo detectado. **Renderizar este clip** no vuelve a descargar ni a transcribir. Si el render falla, se conserva el MP4 anterior.

## 2b. Facecam y karaoke (editor)
- [ ] En «Editar clip», la sección «1 · Cámara en el vídeo original» muestra un solo recuadro rosa sobre el fotograma original. «Ajustar a 16:9 / 4:3» y «Mantener proporción» funcionan.
- [ ] «Vista previa rápida» en «Facecam arriba + gameplay abajo»: la cámara sale **entera** (sus cuatro esquinas) y sin deformar. No hay guías de área segura.
- [ ] «Facecam flotante» en 9:16, 1:1 y 16:9: la cámara sale entera, dentro de las guías. Mover el recuadro del resultado no cambia el recorte del original.
- [ ] «Ver diagnóstico» muestra las muestras, la consistencia, el rectángulo y el motivo. En un vídeo sin cámara: «Sin facecam: sólo gameplay».
- [ ] «Renderizar este clip» con el vídeo del clip abierto en Resultados: termina igualmente, sin `.part`.
- [ ] Subtítulos en karaoke: la frase entera visible y sólo la palabra que se dice en azul (en la vista previa del editor y en el MP4).

## 3. Directo de YouTube (propio o autorizado)
1. **Directos** → pega la URL del directo o del canal (`https://www.youtube.com/@canal`). Acepta el aviso de uso autorizado (sólo la primera vez).
2. Sin directo activo: estado «Esperando directo» y se vuelve a comprobar periódicamente.
3. Con directo: «En directo» y luego «Procesando bloque» cada minuto (bloque de 60 s y 4 s de solape). Los clips de cada bloque aparecen en Resultados como «… · bloque N».
4. **Pausar** y **Reanudar**: el detalle debe mostrar un «hueco». Cierra la app con el monitor activo y ábrela: queda «Pausado» y se puede reanudar.
5. Al terminar el directo: «Finalizado», con un resumen de tiempo vigilado, bloques, clips y espacio liberado. La carpeta `%APPDATA%\Clip Clip\live\<id>` queda vacía, salvo que se eligiera conservar los segmentos.
