# EnvioTec — Parte B: ficha del proyecto

Esta es la Parte B del prompt base (`docs/baseline.md`). Define el dominio de EnvioTec y los controles específicos que se suman al baseline. Los campos marcados `PENDIENTE` deben preguntarse en la Fase 0 si no se resolvieron antes.

## Decisiones clave

| Tema | Decisión | Motivo |
| --- | --- | --- |
| Proveedor | Mailchimp Transactional (Mandrill) vía API HTTP | Mailchimp Marketing no envía adjuntos reales; la API da un ID por mensaje para cruzar eventos por contacto |
| Exposición | Solo interna; eventos por consulta a la API (polling), sin webhooks | Ningún endpoint queda expuesto a internet |
| Datos sensibles | Sí | Contactos son datos personales; los adjuntos pueden incluir datos de pólizas |
| Perfiles | Operador y aprobador separados | Evita que un solo usuario envíe a toda la base (maker-checker) |
| MFA | Administradores y quien envía o aprueba campañas | Una cuenta tomada permite phishing con el dominio de la empresa; AD on-premise no aporta MFA |
| Volumen | Cuota de envío por usuario | Control de abuso y de costo |
| Adjuntos | Un PDF por campaña, el mismo para todos | Simplifica el envío y permite inspeccionar el archivo una sola vez |
| Alcance de datos | Por área | Cada área ve sus datos; vista global solo para administración, auditoría y reportes |
| Autenticación | Usuarios locales y de AD on-premise, un único origen por cuenta | Flexibilidad sin permitir caminos alternativos de acceso |
| Procesos en segundo plano | Worker con cola (BullMQ/Redis) | Envíos programados, sincronización de eventos, reintentos e idempotencia |

## Ficha completa

```text
NOMBRE DEL PROYECTO: EnvioTec
OBJETIVO DE NEGOCIO: Plataforma interna para enviar campañas de correo masivo con un
  PDF adjunto. Los usuarios suben una plantilla Word (.docx) con variables, la combinan
  con una base de contactos y programan el envío dentro de su cuota. Incluye reportes
  de entrega, apertura, clics, rebotes y bajas. Envío mediante Mailchimp Transactional
  (Mandrill) vía API.

TIPO DE USO:          Solo interno. La aplicación es accesible únicamente desde la red
                      de la organización. Ningún endpoint se expone a internet.
                      El estado de los envíos se obtiene consultando la API de
                      Mailchimp (polling), sin webhooks entrantes. El enlace de baja
                      y el píxel de apertura los aloja Mailchimp.
DESTINATARIOS:        PENDIENTE — clientes externos, personal interno o ambos
USUARIOS ESPERADOS:   500 usuarios, 100 concurrentes
VOLUMEN DE ENVÍO:     Cuota de envío por usuario, asignada por un administrador.
                      Período y unidad de la cuota: PENDIENTE (sugerido:
                      destinatarios por mes). Volumen total mensual: PENDIENTE
                      (dimensiona el plan de Mailchimp).
PERFILES DE USUARIO:  administrador, operador de campañas, aprobador, auditoría, reportes

MÓDULOS DE NEGOCIO:
  - Plantillas: subida de .docx, extracción de variables, conversión a HTML
    sanitizado, vista previa aislada, versionado.
    Permisos: templates.view, templates.create, templates.update, templates.delete
  - Contactos: alta manual, importación CSV/Excel, listas o segmentos,
    deduplicación, lista de supresión (bajas, rebotes, quejas).
    Permisos: contacts.view, contacts.create, contacts.update, contacts.import,
    contacts.export, contacts.delete
  - Campañas: plantilla + lista + PDF + programación; flujo
    borrador → enviada a aprobación → aprobada → programada → enviando →
    finalizada / cancelada; envío de prueba; pausa y cancelación.
    Permisos: campaigns.view, campaigns.create, campaigns.update,
    campaigns.submit, campaigns.approve, campaigns.cancel, campaigns.send_test
  - Cuotas: asignación por usuario y período, reserva al aprobar la campaña,
    consumo al enviar, liberación al cancelar, historial de movimientos.
    Permisos: quotas.view, quotas.manage
  - Reportes: entregas, aperturas (aproximadas), clics, rebotes, quejas y bajas
    por campaña y por contacto; exportación.
    Permisos: reports.view, reports.export
  - Sincronización (técnico): worker que consulta periódicamente la API de
    Mailchimp y guarda localmente estados y eventos de cada mensaje, y la
    lista de bajas y rechazos.
  - Administración (núcleo extendido): usuarios locales, vigencia de cuentas
    y parámetros del sistema.
    Permisos: users.create_local, users.renew_local, settings.manage,
    areas.view_all

ADJUNTOS:             Un único PDF por campaña, el mismo para todos los destinatarios.
                      Validación por firma de archivo (no por extensión), tamaño
                      máximo PENDIENTE (sugerido 5 MB), rechazo de PDFs cifrados o con
                      JavaScript, acciones automáticas o archivos embebidos, escaneo
                      antivirus obligatorio.

ALCANCE DE DATOS:     Por área. Contactos, plantillas, campañas y reportes pertenecen
                      a un área: la del atributo department de AD, o la asignada
                      por un administrador en el caso de usuarios locales.
                      Operadores y aprobadores ven y aprueban solo lo de su área;
                      administradores, auditoría y reportes ven todas las áreas
                      (permiso areas.view_all). Usuario sin área asignada: sin
                      acceso a datos de negocio. Si un usuario cambia de área, los
                      registros quedan en el área original. Filtro por área
                      obligatorio en cada consulta del repository y tests de IDOR
                      entre áreas.

DATOS SENSIBLES:      Sí — datos personales de contactos (nombre, correo y variables
                      de plantilla) y posibles datos de pólizas en adjuntos.
                      Enmascarar correos en listados para perfiles sin contacts.view.
NORMATIVA APLICABLE:  Ninguna declarada por el negocio. Los requisitos técnicos de
                      remitentes masivos (SPF, DKIM, DMARC, baja con un clic) aplican
                      igual por entregabilidad.
RETENCIÓN:            Perpetua para datos de negocio, adjuntos, auditoría, eventos de
                      tracking y logs. Tablas de alto volumen particionadas por mes.
                      Logs técnicos: PENDIENTE confirmar (ver recomendación).

INTEGRACIONES:        Mailchimp Transactional API (envío y consulta de eventos; solo
                      tráfico saliente HTTPS); API key de campañas separada de la de
                      correos del sistema. Active Directory on-premise (LDAPS).
CARGA DE ARCHIVOS:    Sí — .docx (plantillas), CSV/XLSX (contactos), PDF (adjunto).
                      Procesamiento en contenedor aislado sin red.
PROCESOS EN SEGUNDO PLANO: Sí — worker con cola (BullMQ/Redis) para envíos
                      programados, sincronización de eventos, procesamiento de
                      archivos y control diario de vigencia de cuentas locales.
CLIENTES NO NAVEGADOR: Ninguno.
OTROS ORÍGENES (CORS): Ninguno.

MFA:                  TOTP de la aplicación obligatorio para administradores y para
                      quien tenga campaigns.submit o campaigns.approve, también con
                      cuentas de AD.
ORIGEN DE USUARIOS:   Mixto — conviven usuarios locales y usuarios de AD, y
                      cualquier perfil puede tener cuenta local o de AD, sin
                      restricción de casos. Una persona tiene una sola cuenta:
                      username y email únicos entre ambos orígenes.
                      Cada usuario tiene un único origen (auth_source: local | ad)
                      y solo puede autenticarse por ese origen. Los usuarios
                      locales los crea un administrador (permiso
                      users.create_local), con área asignada manualmente, la
                      política de contraseñas del baseline y fecha de
                      vigencia parametrizable (ver "Vigencia de cuentas locales").
AUTENTICACIÓN AD:     Active Directory on-premise por LDAPS (o ADFS si existe:
                      PENDIENTE). Forma parte del alcance inicial. Grupos de AD
                      mapeados a roles. Una cuenta deshabilitada en AD pierde
                      acceso de inmediato.
RECUPERACIÓN POR EMAIL: Sí, para usuarios locales. Los usuarios de AD
                      recuperan su contraseña por los canales de AD.

DESPLIEGUE:           Servidor propio con Docker y certificados TLS. Dominio de envío
                      con SPF, DKIM y DMARC configurados. Salida a internet solo hacia
                      la API de Mailchimp (allowlist de egreso).
CI:                   Sin CI por ahora; los chequeos de A11 corren como scripts
                      locales (npm run check) listos para Jenkins.
GESTOR DE SECRETOS:   Docker secrets
IDIOMA DE LA UI:      español e inglés (i18n desde el inicio)
RESTRICCIONES:        ninguna
```

## Controles adicionales específicos de EnvioTec

Estos controles se suman a la Parte A y deben aparecer en el modelo de amenazas de la Fase 0.

- **Plantillas .docx:** solo `.docx` (nunca `.doc` ni `.docm`), límite de tamaño comprimido y descomprimido, parser XML sin entidades externas, procesamiento en contenedor aislado sin red, HTML resultante sanitizado, vista previa en `iframe` con `sandbox`.
- **Variables de plantilla:** allowlist de variables y escape obligatorio; ningún motor de plantillas que ejecute código.
- **PDF adjunto:** verificación por firma `%PDF`, tamaño máximo, rechazo de archivos cifrados o con `/JavaScript`, `/OpenAction`, `/Launch` o `/EmbeddedFile`, escaneo antivirus (ClamAV), almacenamiento privado fuera del alcance web, hash SHA-256 guardado para probar qué archivo se envió.
- **Contactos:** validación por fila al importar, deduplicación, protección contra CSV injection al exportar.
- **Supresión:** bajas, rebotes duros y quejas se excluyen siempre de cualquier envío, sin excepción por rol.
- **Cuotas:** control en el backend dentro de una transacción con bloqueo de fila; ningún usuario modifica su propia cuota; todo movimiento queda auditado.
- **Sincronización con Mailchimp:** worker con reintentos e idempotencia por ID de evento. Los eventos se guardan localmente porque el proveedor no los conserva para siempre.
- **Worker de envío:** reintentos con backoff, idempotencia por mensaje, pausa y cancelación, respeto de límites del proveedor, zona horaria America/La_Paz.
- **LDAPS:** solo LDAP cifrado (636 o StartTLS) con validación de certificado, cuenta de servicio de solo lectura, filtros LDAP escapados (LDAP injection), mapeo de grupos a roles.
- **Egreso de red:** los contenedores solo pueden salir hacia la API de Mailchimp y el controlador de dominio.
- **Abuso interno:** aprobación obligatoria de campañas, cuota por usuario, auditoría de envío, aprobación y cancelación.
- **Reportes:** aclarar que la apertura es una métrica aproximada; incluir clics, rebotes, quejas y bajas.

## Usuarios locales y de AD

- El `username` y el email son únicos entre ambos orígenes, para que una misma persona no tenga una cuenta local y otra de AD. Al sincronizar o crear, una colisión se rechaza y se audita; nunca se fusionan cuentas automáticamente.
- Un usuario de AD nunca tiene contraseña local, y un usuario local nunca se autentica contra AD.
- Al iniciar sesión, un usuario de AD deshabilitado o fuera del grupo habilitado pierde acceso y se revocan sus sesiones.
- Los usuarios locales usan Argon2id, bloqueo progresivo, recuperación por correo y MFA según el baseline.
- Revisión periódica de usuarios locales: listado de cuentas locales activas, último acceso y expiración, disponible para auditoría.
- Se mantiene al menos un usuario local de emergencia con MFA, para operar si AD no está disponible.

## Vigencia de cuentas locales (parametrizable)

| Parámetro | Descripción | Valor sugerido |
| --- | --- | --- |
| `local_account.default_validity_days` | Vigencia que se propone al crear una cuenta local | 90 días |
| `local_account.max_validity_days` | Vigencia máxima permitida; ninguna cuenta puede superarla | 180 días |
| `local_account.renewal_max_days` | Extensión máxima por cada renovación | 90 días |
| `local_account.expiry_warning_days` | Anticipación del aviso de vencimiento | 7 días |
| `local_account.inactivity_disable_days` | Desactivación por falta de uso, aunque la cuenta siga vigente | 45 días |

- Los parámetros se guardan en una tabla `system_settings` con rango válido definido en el backend (mínimo y máximo); un valor fuera de rango se rechaza.
- Solo quien tenga el permiso `settings.manage` puede modificarlos; cada cambio queda auditado con el valor anterior y el nuevo.
- Cada cuenta local guarda su `expires_at`. Al crearla, el administrador puede elegir una fecha menor o igual al máximo, nunca mayor.
- La renovación requiere el permiso `users.renew_local`, re-autenticación y un motivo obligatorio; queda auditada.
- El worker revisa a diario: avisa por correo a la cuenta y a su administrador antes del vencimiento, desactiva las cuentas vencidas o inactivas, revoca sus sesiones y registra el evento.
- Al iniciar sesión también se verifica `expires_at`, para no depender solo del proceso diario.
- Una cuenta vencida no se borra: queda desactivada para conservar la auditoría y puede reactivarse con una renovación.
- La cuenta de emergencia puede marcarse como exenta de vigencia, pero no de MFA, y su uso dispara una alerta y un evento de auditoría destacado.

## Recomendación sobre retención de logs técnicos

La auditoría, los datos de negocio y los eventos de tracking ya cubren las validaciones. Los logs técnicos de la aplicación contienen ruido, IPs y trazas, y conservarlos para siempre aumenta el volumen sin aportar evidencia. Se sugiere conservarlos 12 meses y archivar en frío lo anterior, salvo que el negocio confirme lo contrario.

## Preguntas pendientes

- [x] Alcance de datos: por área
- [x] Usuarios locales: permitidos para todos los casos
- [ ] Destinatarios: clientes externos, personal interno o ambos
- [ ] Cuota: período (mensual, semanal) y unidad (destinatarios, correos o campañas)
- [ ] Volumen total mensual estimado de correos
- [ ] Tamaño máximo del PDF adjunto
- [ ] ¿Existe ADFS o solo controladores de dominio (LDAPS)?
- [ ] Logs técnicos: confirmar retención perpetua o 12 meses + archivo
- [ ] Contacto que pide ser borrado: ¿anonimizar sus datos manteniendo los eventos?
- [ ] Confirmar los valores por defecto de vigencia de cuentas locales
