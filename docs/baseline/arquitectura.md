# Baseline — Arquitectura y estructura de carpetas

> Parte de `docs/baseline.md` (baseline del prompt base), con la misma autoridad. No se modifica sin aprobación explícita.

## A2. Diagrama de componentes

```text
 Navegador
    │  HTTPS (TLS 1.2+, HSTS)
    ▼
┌─────────────────────────────────────┐
│ Proxy de borde (Traefik)            │
│  /        → archivos estáticos      │
│  /api/*   → backend                 │
└───────────────┬─────────────────────┘
                │ red interna Docker
                ▼
┌─────────────────────────────────────┐
│ Backend Fastify (N réplicas)        │
│ Route → Hooks (auth, permisos)      │
│       → Controller → Service        │
│       → Repository                  │
└──────┬──────────────────────┬───────┘
       │                      │
       ▼                      ▼
┌──────────────┐      ┌──────────────┐
│ PostgreSQL   │      │ Redis        │
│ (red interna)│      │ (red interna)│
└──────────────┘      └──────────────┘
```

## A3. Estructura de carpetas: modular por dominio

El backend se organiza **por módulo de dominio**, no por tipo técnico. Agregar un módulo de negocio nuevo significa agregar una carpeta en `modules/` sin tocar el núcleo. La seguridad compartida vive en `core/`.

```text
project/
├── backend/
│   ├── src/
│   │   ├── core/                  # Reutilizable en todos los proyectos
│   │   │   ├── config/            # Carga y validación de variables de entorno
│   │   │   ├── db/                # Pool, transacciones, helpers de consultas
│   │   │   ├── http/              # Formato de respuestas, paginación, request ID
│   │   │   ├── errors/            # Clases de error y error handler central
│   │   │   ├── logging/           # Logger con redacción de datos sensibles
│   │   │   ├── security/          # Headers, CSRF, rate limiting, hashing
│   │   │   ├── auth/              # Sesiones y autenticación
│   │   │   ├── authorization/     # requirePermission, catálogo de permisos
│   │   │   └── audit/             # Servicio de auditoría
│   │   ├── modules/               # Un módulo por dominio
│   │   │   ├── users/
│   │   │   │   ├── users.routes.js
│   │   │   │   ├── users.controller.js
│   │   │   │   ├── users.service.js
│   │   │   │   ├── users.repository.js
│   │   │   │   ├── users.schemas.js
│   │   │   │   └── users.permissions.js
│   │   │   ├── roles/
│   │   │   ├── auth/
│   │   │   └── audit-logs/
│   │   ├── app.js                 # Construye la app (sin listen); usada por los tests
│   │   └── server.js              # Solo arranque y apagado ordenado
│   ├── tests/
│   │   ├── unit/
│   │   ├── integration/
│   │   └── security/
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── core/                  # api client, auth, permissions, router, errores
│   │   ├── components/            # DataTable, Modal, Form, Pagination, Toast...
│   │   ├── pages/                 # Una carpeta por pantalla
│   │   ├── utils/                 # Incluye helpers de DOM seguros
│   │   ├── styles/
│   │   └── app.js
│   └── tests/
├── database/
│   ├── migrations/
│   └── seeds/                     # Separar seeds de sistema y de desarrollo
├── proxy/                         # Configuración de Traefik
├── docs/
│   ├── architecture.md
│   ├── security.md                # Modelo de amenazas y controles
│   ├── decisions/                 # ADRs numerados
│   └── openapi.yaml
├── .env.example
├── docker-compose.yml
├── docker-compose.override.yml    # Solo desarrollo
├── .gitignore
├── .dockerignore
└── README.md
```

**Reglas de tamaño:** ningún archivo debe superar unas 300 líneas ni mezclar responsabilidades. Si crece, se divide.

**Cada decisión de arquitectura relevante** se documenta como ADR en `docs/decisions/` (contexto, decisión, alternativas descartadas, consecuencias).
