# ADR-030: Variables de fecha y envío según la fecha de cada contacto

- **Estado:** Aceptado (pedido por el usuario el 2026-11-11)
- **Fecha:** 2026-11-11

## Contexto

El negocio necesita cargar en la lista una fecha por contacto, en formato DD/MM/AAAA (por ejemplo, el vencimiento de una póliza), y que cada contacto reciba el correo según su propia fecha.

## Decisión

### Variables de fecha

Las variables de una lista tienen tipo **Texto** o **Fecha**. El tipo se elige al crearla y no cambia después.

- **Formatos aceptados:** DD/MM/AAAA, también con un dígito (D/M/AAAA), y AAAA-MM-DD desde el selector de fecha del navegador. Se rechazan las fechas imposibles, como el 31/02.
- **Al importar:** una fecha inválida rechaza la fila con el error `invalid_date`.
- **Almacenamiento y presentación:** se guarda como AAAA-MM-DD. En pantalla, en la exportación y en el correo se muestra como DD/MM/AAAA.

### Programación según la fecha del contacto

La campaña indica la variable de fecha, un desfase en días (de −365 a 365) y una hora de envío (America/La_Paz). No se combina con una fecha y hora fija.

**Al aprobar,** cada destinatario recibe su `send_at`, que es su fecha más el desfase, a la hora indicada.

- **Quedan fuera y se informan** (decisiones del usuario):
  - los contactos sin fecha;
  - aquellos cuyo momento de envío ya pasó;
  - los que caen a más de 365 días.
- **Cuota:** se reserva solo la de los incluidos.
- **Primer envío:** el `scheduled_at` de la campaña es el primer `send_at`.
- **Foto fija:** la foto queda fija como en el resto de las campañas. Si después cambia una fecha en la lista, hay que editar la campaña y volver a aprobarla.

**En el worker:**

- cada ciclo arma lotes solo con los destinatarios cuyo `send_at` ya llegó;
- la campaña sigue *Enviando* hasta que no queda ningún destinatario pendiente;
- la supresión, el tope global, la pausa y la cancelación se aplican a cada envío diario, como en cualquier campaña.

**En el reporte:**

- hay una tabla por día programado;
- cada destinatario muestra su fecha programada.

### Fuera del alcance

El envío anual repetido (cumpleaños, aniversarios) no se implementa, por decisión del usuario.

## Consecuencias

- Una aprobación puede quedar vigente hasta 365 días. Durante ese tiempo la reserva de cuota sigue a nombre del creador.
- El tope global mensual se evalúa en cada día de envío, así que una campaña larga puede pausarse en un mes con mucho volumen.
