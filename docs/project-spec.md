# EnvioTec — Parte B: ficha del proyecto

Esta es la Parte B del prompt base (`docs/baseline.md`). Define el dominio de EnvioTec y los controles específicos que se suman al baseline. Las preguntas pendientes se resolvieron en la Fase 0 (2026-10-31); el detalle de cada decisión está en `docs/security.md` y en `docs/decisions/`.

## Decisiones clave

| Tema | Decisión | Motivo |
| --- | --- | --- |
| Proveedor | Mailchimp Transactional (Mandrill) vía API HTTP | Mailchimp Marketing no envía adjuntos reales; la API da un ID por mensaje para cruzar eventos por contacto |
| Exposición | Solo interna; eventos por consulta a la API (polling), sin webhooks | Ningún endpoint queda expuesto a internet |
| Datos sensibles | Datos personales de contactos; el PDF adjunto no lleva datos sensibles | Definición del negocio; los contactos siguen siendo datos personales |
| Perfiles | Operador y aprobador separados; nadie aprueba su propia campaña | Evita que un solo usuario envíe a toda la base (maker-checker) |
| MFA | Administradores y quien envía o aprueba campañas | Una cuenta tomada permite phishing con el dominio de la empresa; AD on-premise no aporta MFA |
| Volumen | Saldo de envíos por usuario y tope global mensual de 100.000 envíos | Control de abuso y de costo; el plan contratado es de 100.000 envíos al mes |
| Adjuntos | PDF opcional: como máximo uno por campaña, el mismo para todos, máximo 5 MB (ADR-027) | Simplifica el envío y permite inspeccionar el archivo una sola vez |
| Alcance de datos | Por área | Cada área ve sus datos; vista global solo para administración, auditoría y reportes |
| Autenticación | Usuarios locales y de AD on-premise (LDAPS), un único origen por cuenta; administradores solo locales | Flexibilidad sin permitir caminos alternativos de acceso ni roles administrativos otorgados desde AD |
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
DESTINATARIOS:        Ambos: clientes externos y personal interno.
USUARIOS ESPERADOS:   500 usuarios, 100 concurrentes
VOLUMEN DE ENVÍO:     Plan transaccional de 100.000 envíos al mes.
                      Cuota por usuario: saldo de envíos asignado por un
                      administrador, sin período. Cada destinatario de una campaña
                      y cada envío de prueba descuenta 1.
                      - Cuenta local: el saldo se usa durante la vigencia de la
                        cuenta; al renovarla, el saldo se mantiene (no se reinicia).
                      - Cuenta de AD: el saldo no vence; solo cambia cuando un
                        administrador lo ajusta.
                      Tope global mensual (system_settings, por defecto 100.000):
                      al alcanzarlo, el worker pausa las campañas en curso y avisa.
PERFILES DE USUARIO:  administrador, operador de campañas, aprobador, auditoría, reportes

MÓDULOS DE NEGOCIO:
  - Plantillas: subida de .docx, extracción de variables, conversión a HTML
    sanitizado, vista previa aislada, versionado. Imágenes del .docx enviadas
    como adjuntos inline (cid), con límite de cantidad y peso; sin imágenes
    remotas. Enlaces solo https: y mailto:.
    Permisos: templates.view, templates.create, templates.update, templates.delete
  - Contactos: alta manual, importación CSV (XLSX fuera de la v1), listas o
    segmentos, deduplicación, lista de supresión (bajas, rebotes, quejas),
    anonimización a pedido del contacto. Campos fijos (email, nombre, apellido)
    más variables propias por lista, cada una con nombre técnico validado
    (^[a-z][a-z0-9_]{0,39}$) y etiqueta; una variable con datos no se borra.
    La importación CSV asocia cada columna a un campo o variable de la
    lista antes de importar (ADR-028). Las variables son de tipo texto o
    fecha; las fechas se cargan como DD/MM/AAAA (ADR-030).
    Permisos: contacts.view, contacts.create, contacts.update, contacts.import,
    contacts.export, contacts.delete, suppressions.view, suppressions.manage
  - Campañas: plantilla + lista + PDF opcional + remitente + programación; flujo
    borrador → enviada a aprobación → aprobada → programada → enviando →
    finalizada / cancelada; envío de prueba; pausa y cancelación.
    - Una sola aprobación; nadie aprueba una campaña que envió a aprobación.
    - Aprobada o programada sin envíos iniciados: se puede editar, pero vuelve
      a borrador, libera la cuota reservada y requiere una nueva aprobación.
    - Enviando o en pausa: no se edita; solo se puede cancelar.
    - Las variables de la plantilla deben existir en la lista elegida.
    - Programación al aprobarse, en una fecha y hora fija, o según una
      variable de fecha de cada contacto (con desfase en días y hora de
      envío); en este caso se excluyen e informan los contactos sin fecha,
      con fecha ya pasada o a más de 365 días (ADR-030).
    - Envío de prueba: solo al correo del propio usuario o a dominios internos
      permitidos (system_settings), máximo 5 por usuario por día; descuenta
      del saldo de cuota y del tope global.
    Permisos: campaigns.view, campaigns.create, campaigns.update,
    campaigns.delete (solo borradores), campaigns.submit, campaigns.approve,
    campaigns.cancel, campaigns.pause, campaigns.send_test
  - Remitentes: lista permitida de remitentes (From) por área, mantenida por un
    administrador. Dominio de envío: subdominio dedicado (por ejemplo
    envios.empresa.com) con DKIM de Mandrill y DMARC alineado.
    Permisos: senders.manage
  - Cuotas: saldo por usuario, reserva al aprobar la campaña, consumo al
    enviar, liberación al cancelar o al volver a borrador, tope global mensual,
    historial de movimientos.
    Permisos: quotas.view, quotas.manage
  - Reportes: entregas, aperturas (aproximadas), clics, rebotes, quejas y bajas
    por campaña y por contacto; exportación.
    Permisos: reports.view, reports.export
  - Sincronización (técnico): worker que consulta periódicamente la API de
    Mailchimp y guarda localmente estados y eventos de cada mensaje, y la
    lista de bajas y rechazos. Mandrill conserva la información 30 días (a
    confirmar en el spike de la fase 0.5).
  - Administración (núcleo extendido): usuarios locales, vigencia de cuentas,
    áreas y su equivalencia con el department de AD, equivalencia de grupos
    de AD a roles de negocio, desbloqueo de cuentas y parámetros del sistema.
    Permisos: users.create_local, users.renew_local, users.unlock,
    users.reset_mfa,
    settings.manage, areas.view_all, areas.manage, directory.manage
    (users.create del baseline no se usa: las cuentas locales usan
    users.create_local y las de AD se crean en el primer login)

ADJUNTOS:             PDF opcional (2026-11-07, ADR-027): como máximo uno por campaña,
                      el mismo para todos los destinatarios.
                      Validación por firma de archivo (no por extensión), tamaño
                      máximo 5 MB, rechazo de PDFs cifrados o con JavaScript,
                      acciones automáticas o archivos embebidos, escaneo antivirus
                      obligatorio. Se mantienen todos los controles aunque el PDF
                      no lleve datos sensibles: protegen contra la distribución de
                      malware desde el dominio de la empresa.

ALCANCE DE DATOS:     Por área. Contactos, plantillas, campañas y reportes pertenecen
                      a un área. Cada usuario pertenece a una sola área:
                      - Usuario local: área obligatoria, asignada por un
                        administrador al crearlo.
                      - Usuario de AD: área cuyo campo ad_department coincide con
                        el atributo department de AD, sin distinguir mayúsculas.
                        Sin coincidencia: entra sin área.
                      Operadores y aprobadores ven y aprueban solo lo de su área;
                      administradores, auditoría y reportes ven todas las áreas
                      (permiso areas.view_all). Usuario sin área asignada: sin
                      acceso a datos de negocio. Si un usuario cambia de área, los
                      registros quedan en el área original. Filtro por área
                      obligatorio en cada consulta del repository y tests de IDOR
                      entre áreas.

DATOS SENSIBLES:      Datos personales de contactos (nombre, correo y variables de
                      plantilla). Por definición del negocio, el PDF adjunto no
                      lleva datos sensibles.
                      Enmascarar correos en listados para perfiles sin contacts.view.
                      Contacto que pide ser borrado: se anonimizan sus datos
                      personales, sus eventos se conservan con un ID seudónimo y el
                      hash de su email queda en la lista de supresión.
NORMATIVA APLICABLE:  Ninguna declarada por el negocio. Los requisitos técnicos de
                      remitentes masivos (SPF, DKIM, DMARC, baja con un clic) aplican
                      igual por entregabilidad.
RETENCIÓN:            Perpetua para datos de negocio, adjuntos, auditoría y eventos de
                      tracking. Tablas de alto volumen particionadas por mes.
                      Logs técnicos: 12 meses y luego archivo en frío.

INTEGRACIONES:        Mailchimp Transactional API (envío y consulta de eventos; solo
                      tráfico saliente HTTPS); API key de campañas separada de la de
                      correos del sistema. Active Directory on-premise (LDAPS).
CARGA DE ARCHIVOS:    Sí — .docx (plantillas), CSV (contactos), PDF (adjunto).
                      Procesamiento en un contenedor aislado en una red Docker
                      interna: solo ve Redis (cola) y ClamAV; sin acceso a
                      PostgreSQL, sin credenciales de BD y sin salida a internet.
PROCESOS EN SEGUNDO PLANO: Sí — worker con cola (BullMQ/Redis) para envíos
                      programados, sincronización de eventos, procesamiento de
                      archivos, control diario de vigencia de cuentas locales y
                      revisión de cuentas de AD cada 15 minutos.
CLIENTES NO NAVEGADOR: Ninguno.
OTROS ORÍGENES (CORS): Ninguno.

MFA:                  TOTP de la aplicación obligatorio para administradores y para
                      quien tenga campaigns.submit o campaigns.approve, también con
                      cuentas de AD. Una cuenta de AD solo puede configurar
                      su MFA con un código de enrolamiento de un solo uso que
                      emite un administrador (permiso users.reset_mfa) y
                      entrega por otro canal; vence a las 24 horas
                      (mfa.enrollment_code_validity_hours). El mismo mecanismo
                      sirve para reconfigurar el MFA si se pierde el
                      dispositivo. Las exportaciones (contacts.export,
                      reports.export) no exigen MFA: riesgo aceptado (ADR-014).
ORIGEN DE USUARIOS:   Mixto — conviven usuarios locales y usuarios de AD. Los roles
                      administrativos solo se asignan a cuentas locales; el resto
                      de los perfiles puede tener cuenta local o de AD. Una persona
                      tiene una sola cuenta: username y email únicos entre ambos
                      orígenes.
                      Cada usuario tiene un único origen (auth_source: local | ad)
                      y solo puede autenticarse por ese origen. Los usuarios
                      locales los crea un administrador (permiso
                      users.create_local), con área obligatoria, la política de
                      contraseñas del baseline y fecha de vigencia parametrizable
                      (ver "Vigencia de cuentas locales").
AUTENTICACIÓN AD:     Active Directory on-premise solo por LDAPS (no hay ADFS).
                      Forma parte del alcance inicial.
                      - Las cuentas se crean en el primer login (JIT), solo si la
                        persona pertenece al grupo habilitado; se identifican por
                        objectGUID.
                      - Los grupos de AD se mapean solo a roles de negocio
                        (operador, aprobador, auditoría, reportes), nunca a roles
                        administrativos.
                      - Una cuenta deshabilitada en AD o fuera del grupo habilitado
                        pierde acceso en un máximo de 15 minutos: el worker revisa
                        AD cada 15 minutos y revoca sesiones; también se revisa en
                        cada login y en cada re-autenticación.
                      - AD bloquea la cuenta a los 3 intentos y reinicia el
                        contador a los 15 minutos. EnvioTec corta a los 2 intentos
                        fallidos por cuenta de AD y bloquea esa cuenta 15 minutos.
RECUPERACIÓN POR EMAIL: Sí, para usuarios locales. Los usuarios de AD
                      recuperan su contraseña por los canales de AD.

DESPLIEGUE:           Servidor propio con Docker. TLS en el proxy de borde (Nginx)
                      con certificado emitido por la CA interna de la organización.
                      Dominio de envío con SPF, DKIM y DMARC configurados. Salida a
                      internet solo a través de un proxy de egreso con allowlist
                      de dominios: API de Mailchimp y actualización de firmas de
                      ClamAV (freshclam).
CI:                   Sin CI por ahora; los chequeos de A11 corren como scripts
                      locales (npm run check) listos para Jenkins.
GESTOR DE SECRETOS:   Docker secrets
IDIOMA DE LA UI:      español e inglés (i18n desde el inicio)
RESTRICCIONES:        ninguna
```

## Controles adicionales específicos de EnvioTec

Estos controles se suman a la Parte A y aparecen en el modelo de amenazas (`docs/security.md`).

- **Plantillas .docx:** solo `.docx` (nunca `.doc` ni `.docm`), límite de tamaño comprimido y descomprimido, parser XML sin entidades externas, rechazo de relaciones externas, procesamiento en el contenedor aislado, HTML resultante sanitizado, vista previa en `iframe` con `sandbox`.
- **Variables de plantilla:** allowlist de variables y escape obligatorio; ningún motor de plantillas que ejecute código.
- **PDF adjunto:** verificación por firma `%PDF`, tamaño máximo de 5 MB, rechazo de archivos cifrados o con `/JavaScript`, `/OpenAction`, `/Launch` o `/EmbeddedFile` (después de normalizar el archivo con qpdf), escaneo antivirus (ClamAV con firmas actualizadas), almacenamiento privado fuera del alcance web, hash SHA-256 guardado para probar qué archivo se envió.
- **Contactos:** validación por fila al importar, deduplicación, protección contra CSV injection al exportar.
- **Supresión:** bajas, rebotes duros y quejas se excluyen siempre de cualquier envío, sin excepción por rol. La supresión vale para toda la empresa, no solo para el área.
- **Cuotas:** control en el backend dentro de una transacción con bloqueo de fila; ningún usuario modifica su propia cuota; todo movimiento queda auditado; el tope global mensual también se controla con bloqueo de fila.
- **Remitentes:** el From y el Reply-To solo salen de la lista permitida del área.
- **Sincronización con Mailchimp:** worker con reintentos e idempotencia por evento. Los eventos se guardan localmente porque el proveedor los conserva 30 días.
- **Worker de envío:** envío por lotes, reintentos con backoff, idempotencia por mensaje y conciliación antes de reintentar un lote con resultado incierto, pausa y cancelación, respeto de límites del proveedor y del tope global, zona horaria America/La_Paz.
- **LDAPS:** solo LDAP cifrado (636 o StartTLS) con validación de certificado, cuenta de servicio de solo lectura, filtros LDAP escapados (LDAP injection), rechazo de contraseñas vacías, mapeo de grupos solo a roles de negocio.
- **Egreso de red:** los contenedores solo salen a través del proxy de egreso hacia la API de Mailchimp y la actualización de firmas de ClamAV, y por red al controlador de dominio.
- **Abuso interno:** aprobación obligatoria de campañas, cuota por usuario, tope global, envíos de prueba limitados, auditoría de envío, aprobación y cancelación.
- **Reportes:** aclarar que la apertura es una métrica aproximada; incluir clics, rebotes, quejas y bajas.

## Usuarios locales y de AD

- El `username` y el email son únicos entre ambos orígenes, para que una misma persona no tenga una cuenta local y otra de AD. Al sincronizar o crear, una colisión se rechaza y se audita; nunca se fusionan cuentas automáticamente.
- Un usuario de AD nunca tiene contraseña local, y un usuario local nunca se autentica contra AD.
- Un usuario de AD nunca tiene roles administrativos; la base de datos lo impide.
- Un usuario de AD deshabilitado o fuera del grupo habilitado pierde acceso y se revocan sus sesiones: en el login, en la re-autenticación y en la revisión del worker cada 15 minutos.
- Los usuarios locales usan Argon2id, bloqueo progresivo, recuperación por correo y MFA según el baseline.
- Revisión periódica de usuarios locales: listado de cuentas locales activas, último acceso y expiración, disponible para auditoría.
- Se mantiene al menos un usuario local de emergencia con MFA, para operar si AD no está disponible.

## Vigencia de cuentas locales (parametrizable)

| Parámetro | Descripción | Valor por defecto |
| --- | --- | --- |
| `local_account.default_validity_days` | Vigencia que se propone al crear una cuenta local | 90 días |
| `local_account.max_validity_days` | Vigencia máxima permitida; ninguna cuenta puede superarla | 180 días |
| `local_account.renewal_max_days` | Extensión máxima por cada renovación | 90 días |
| `local_account.expiry_warning_days` | Anticipación del aviso de vencimiento | 7 días |
| `local_account.inactivity_disable_days` | Desactivación por falta de uso, aunque la cuenta siga vigente | 45 días |

- Los parámetros se guardan en una tabla `system_settings` con rango válido definido en el backend (mínimo y máximo); un valor fuera de rango se rechaza.
- Solo quien tenga el permiso `settings.manage` puede modificarlos; cada cambio queda auditado con el valor anterior y el nuevo.
- Cada cuenta local guarda su `expires_at`. Al crearla, el administrador puede elegir una fecha menor o igual al máximo, nunca mayor.
- La renovación requiere el permiso `users.renew_local`, re-autenticación y un motivo obligatorio; queda auditada. Nadie renueva su propia cuenta. El saldo de cuota se mantiene al renovar.
- El worker revisa a diario: avisa por correo a la cuenta y a la lista de administradores configurada en `system_settings` (`notifications.admin_emails`) antes del vencimiento, desactiva las cuentas vencidas o inactivas, revoca sus sesiones y registra el evento.
- Al iniciar sesión también se verifica `expires_at`, para no depender solo del proceso diario.
- Una cuenta vencida no se borra: queda desactivada para conservar la auditoría y puede reactivarse con una renovación.
- La cuenta de emergencia puede marcarse como exenta de vigencia, pero no de MFA. Su uso dispara una alerta por correo a `notifications.admin_emails` y un evento de auditoría destacado.

## Preguntas pendientes

Todas resueltas en la Fase 0 (2026-10-31).

- [x] Alcance de datos: por área
- [x] Usuarios locales: permitidos para todos los perfiles; los administradores solo pueden ser locales
- [x] Destinatarios: ambos (externos e internos)
- [x] Cuota: saldo de envíos por usuario, sin período, más tope global mensual
- [x] Volumen total mensual: 100.000 envíos (plan transaccional)
- [x] Tamaño máximo del PDF adjunto: 5 MB
- [x] ADFS o LDAPS: solo LDAPS
- [x] Logs técnicos: 12 meses y luego archivo en frío
- [x] Contacto que pide ser borrado: anonimizar, conservar eventos con ID seudónimo y mantener el hash del email en supresión
- [x] Vigencia de cuentas locales: valores por defecto 90 / 180 / 90 / 7 / 45 días
