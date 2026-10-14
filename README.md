# Calcapp ✏️

Calcá cualquier imagen sobre papel usando la cámara del celular. Cargás una foto, le bajás la opacidad y dibujás en el papel siguiendo lo que ves en la pantalla.

**By [@YoSoyJoe](https://yosoyjoe.vercel.app/)**

## Qué hace

- Muestra la cámara trasera en vivo con la imagen encima.
- Opacidad regulable con un deslizador.
- Gestos: un dedo mueve la imagen; dos dedos la agrandan, achican y giran (con imán a 0°/90°).
- **Modo boceto:** convierte la foto en líneas tipo lápiz. Se puede elegir intensidad, detalle y color (negro, rojo, azul o blanco).
- **Bloquear:** esconde los controles y congela la imagen. Para desbloquear hay que mantener apretado el candado.
- La pantalla no se apaga mientras calcás.
- Linterna, solo en Android/Chrome. Safari en iPhone no la permite.
- Grilla, espejar, centrar y cambiar de cámara.
- **Sin cámara:** fondo blanco para calcar apoyando una hoja finita sobre la pantalla.
- **Nuevo dibujo:** si ya estás calcando algo, primero pregunta. La imagen actual solo se reemplaza cuando elegís otra.
- **Tu dibujo queda guardado:** si cerrás la app, al reabrirla volvés directo a Calcar con la misma imagen, posición, opacidad y modo.
- Se puede instalar como app (PWA) y funciona sin internet. El botón «Instalar» solo aparece en la web: en la app instalada no se ve.

No usa servidor, base de datos ni API keys: todo corre en el teléfono y las imágenes nunca salen del dispositivo.

## Estructura

```
index.html            pantallas (carga, inicio, calcar)
styles.css            estilos
app.js                lógica: cámara, gestos, boceto, bloqueo
sw.js                 service worker (offline)
manifest.webmanifest  datos para instalar la app
vercel.json           headers (permiso de cámara, caché del SW)
icons/                ícono en SVG y PNG
fonts/                tipografía Fredoka (licencia OFL, incluida)
img/                  foto de ejemplo para Ayuda (ver abajo)
```

## Foto de ejemplo en Ayuda

Poné tu foto de cómo se coloca el celular en `img/ayuda-celular.jpg` (también sirve `.png` o `.webp`). Aparece en la ventana de Ayuda, con un marco tipo polaroid. Mientras no haya foto, se muestra la ilustración del vaso.

Recomendado: foto horizontal o cuadrada, de unos 1200 px de ancho y menos de 400 KB.

## Subirla a GitHub + Vercel

1. Creá un repo nuevo en GitHub (por ejemplo `calcapp`) y subí todos estos archivos a la raíz:
   ```bash
   git init
   git add .
   git commit -m "Calcapp v1"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/calcapp.git
   git push -u origin main
   ```
   También podés arrastrar los archivos desde la web de GitHub: «Add file → Upload files».
2. En [vercel.com/new](https://vercel.com/new), importá el repo.
   - Framework Preset: **Other**.
   - Build Command y Output Directory: **vacíos**. Es un sitio estático.
3. Deploy. Va a quedar en algo como `https://calcapp.vercel.app`. Cada `git push` actualiza la app sola.

> La cámara solo funciona con **https**. Vercel ya lo da, así que no hay que configurar nada.

## Probarla en tu compu

```bash
python3 -m http.server 8080
# abrí http://localhost:8080
```

En la compu la rueda del mouse hace zoom y Shift + rueda rota la imagen.

## Actualizaciones

Cuando subas cambios grandes, cambiá `VERSION` en `sw.js` (por ejemplo `calcapp-v3`). Así los celulares que la tienen instalada borran la versión vieja guardada.
