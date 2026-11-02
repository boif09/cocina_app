# Cocina en casa

Aplicación web para guardar recetas, preparar el menú semanal y gestionar una lista de la compra visual.

## Funciones incluidas

### Recetas

- Crear, editar, buscar y eliminar recetas.
- Ingredientes con cantidad, unidad y notas.
- Pasos ordenados de preparación.
- Raciones y tiempos opcionales.
- Los ingredientes nuevos se guardan automáticamente en el catálogo.
- Cada receta crea o enlaza automáticamente un plato para usarlo en el menú.
- Botón para añadir todos los ingredientes de una receta a la lista de la compra.

### Menú semanal

- Comida y cena de lunes a domingo.
- Las casillas pueden quedarse vacías.
- Navegación entre semanas.
- Autocompletado con platos utilizados anteriormente.
- Los platos nuevos se guardan al guardar el menú.
- Un plato puede enlazarse con una receta.
- Desde el menú se puede abrir la receta o crearla con el nombre del plato ya rellenado.

### Lista de la compra

- Catálogo inicial de 134 ingredientes habituales.
- Buscador con autocompletado.
- Los ingredientes nuevos se añaden al catálogo automáticamente.
- Ingredientes mostrados como etiquetas visuales.
- Un clic marca o desmarca el ingrediente como comprado.
- Cantidad y unidad opcionales.
- Posibilidad de quitar los comprados o empezar una nueva lista.

### App instalable (PWA)

- Se puede instalar en el móvil o el ordenador desde el navegador ("Añadir a pantalla de inicio" / "Instalar").
- `public/manifest.webmanifest`, `public/sw.js` e iconos en `public/icons/` (se regeneran con `node scripts/make-icons.js`).
- El service worker usa la red primero; sin conexión muestra la última versión guardada. Las escrituras nunca se guardan en caché.
- Al cambiar los archivos que lista `SHELL` en `sw.js` no hace falta subir la versión de la caché, porque siempre se pide primero a la red.

## Tecnología

- Node.js 24 o superior.
- Express.
- SQLite nativo de Node.js mediante `node:sqlite`.
- HTML, CSS y JavaScript sin frameworks.
- Base de datos y tablas creadas automáticamente al arrancar.

## Estructura

```text
cocina_app/
├── data/
│   └── cocina.db          # Se crea automáticamente y no se sube a Git
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── src/
│   ├── config.js
│   ├── db.js
│   └── server.js
├── test/
│   └── smoke-db.js
├── config.json
├── schema.sql
└── package.json
```

## Instalación local

```bash
npm install
npm start
```

Abrir:

```text
http://localhost:3002/cocina
```

La configuración predeterminada está en `config.json`:

```json
{
  "app": {
    "port": 3002,
    "basePath": "/cocina"
  },
  "database": {
    "provider": "sqlite",
    "path": "./data/cocina.db",
    "url": ""
  }
}
```

También se puede sobrescribir con variables de entorno:

```bash
PORT=3002
BASE_PATH=/cocina
DATABASE_PATH=./data/cocina.db
```

## Prueba de SQLite

```bash
npm test
```

La prueba comprueba la creación de tablas, los ingredientes iniciales, la lista inicial y que ingredientes y platos no se dupliquen por diferencias de mayúsculas.

## Despliegue en el servidor con PM2

Ejemplo suponiendo que el proyecto está en `/var/www/cocina_app`:

```bash
cd /var/www/cocina_app
npm install
pm2 start npm --name cocina -- start
pm2 save
```

Para actualizar después de subir cambios a GitHub:

```bash
cd /var/www/cocina_app
git pull
npm install
pm2 restart cocina
```

## Nginx

> En producción la app vive en el subdominio `https://cocina.jusboif.es` (con `BASE_PATH=/`, sitio `/etc/nginx/sites-available/cocina` y regla en Authelia). Un subdominio propio es necesario para poder instalar la PWA junto a otras apps del mismo dominio. La ruta antigua `/cocina/` redirige al subdominio. El ejemplo de abajo (ruta `/cocina/`) sirve para desarrollo o para un servidor sin subdominio.

Añadir un bloque como este dentro del servidor que ya atiende la IP o el dominio:

```nginx
location = /cocina {
    return 301 /cocina/;
}

location /cocina/ {
    proxy_pass http://127.0.0.1:3002/cocina/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Después:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Copia de seguridad

La información se guarda en:

```text
data/cocina.db
```

Ese archivo no se sube al repositorio. Conviene copiarlo periódicamente a otra ubicación.
