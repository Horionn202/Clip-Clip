# Pruebas manuales

Guía corta para comprobar las funciones que dependen de vídeo real. Los tests automáticos (`npm test`) cubren la lógica, pero no estas pruebas.

> **Datos aislados (sólo desarrollo).** Para no tocar `%APPDATA%\Clip Clip`, arranca con una carpeta de datos de prueba:
> `$env:CLIP_CLIP_DATA_DIR = "C:uta\de\prueba"; npm run dev`.
> La app instalada ignora esta variable.

## 1. Vídeo normal (sin facecam)
1. Inicio → pega la URL de un vídeo autorizado de 3–10 min → clips de 30 s → Crear.
2. En **Trabajos** deben verse las 9 tarjetas: la actual en azul/violeta con porcentaje y tiempo, las anteriores en verde y las siguientes en gris. Ninguna en rojo salvo que falle.
3. En la tarjeta «Transcribiendo» deben aparecer los minutos procesados, el modelo y GPU/CPU.
4. En **Resultados**, abre un clip con **Editar clip → Subtítulos**. Reproduce y comprueba que cada frase aparece cuando se dice. Divide un cue, cambia un texto, **Guardar cambios** y **Renderizar este clip**: sólo cambia ese clip.

## 2. Vídeo de gameplay con cámara abajo a la derecha
1. Crea un trabajo con un vídeo de gameplay con facecam rectangular en la esquina inferior derecha.
2. Con «Plantilla por defecto: automática», el clip debe salir como «Gameplay arriba + facecam abajo», con la cámara entera (sin cortar la cara).
3. Si la detección falla, el clip debe mostrar **«Revisar composición»** y usar «Gameplay completo».
4. Editar clip → Composición:
   - elige «Gameplay arriba + cámara abajo»;
   - arrastra el recuadro hasta la cámara y redimensiónalo desde la esquina (también con flechas y Mayús+flechas);
   - pulsa **Vista previa rápida**.
5. Cambia a «Personalizado» y coloca la caja en la salida, dentro del área segura punteada. Prueba 1:1 y 16:9.
6. **Restablecer detección automática** vuelve a lo detectado. **Renderizar este clip** no vuelve a descargar ni a transcribir. Si el render falla, se conserva el MP4 anterior.

## 3. Directo de YouTube (propio o autorizado)
1. **Directos** → pega la URL del directo o del canal (`https://www.youtube.com/@canal`). Acepta el aviso de uso autorizado (sólo la primera vez).
2. Sin directo activo: estado «Esperando directo» y se vuelve a comprobar periódicamente.
3. Con directo: «En directo» y luego «Procesando bloque» cada minuto (bloque de 60 s y 4 s de solape). Los clips de cada bloque aparecen en Resultados como «… · bloque N».
4. **Pausar** y **Reanudar**: el detalle debe mostrar un «hueco». Cierra la app con el monitor activo y ábrela: queda «Pausado» y se puede reanudar.
5. Al terminar el directo: «Finalizado», con un resumen de tiempo vigilado, bloques, clips y espacio liberado. La carpeta `%APPDATA%\Clip Clip\live\<id>` queda vacía, salvo que se eligiera conservar los segmentos.
