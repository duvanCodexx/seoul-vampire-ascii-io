# Seúl en Cuarentena // ASCII.io (Inspirado en ztryfu)

Juego multijugador `.io` en tiempo real con estética **100% ASCII en vista isométrica**, listo para desplegar en **Dokploy**.

## Variables de entorno
- `PORT`: Puerto donde escucha el servidor HTTP + WebSocket (por defecto `8765`).
- `ALLOWED_ORIGIN`: Origen permitido para cabeceras CORS (por defecto `*`, refleja el `Origin` de tu dominio en Dokploy).

## Despliegue en Dokploy
1. Conecta este repositorio en Dokploy usando **Dockerfile** (o Nixpacks con `npm start`).
2. En **Environment Variables**, define `PORT=8765` (o el puerto que configures en el dominio de Dokploy).
3. En **Domains**, apunta tu dominio al mismo puerto configurado en `PORT`. El servidor incluye cabeceras CORS/proxy (`X-Forwarded-*`), soporte `wss://` automático y healthcheck en `/health`.

## Ejecución local
```powershell
node server.js
```
Abre **`http://127.0.0.1:8765/`** en una o varias pestañas del navegador.
