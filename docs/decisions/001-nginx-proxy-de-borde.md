# ADR-001: Nginx como proxy de borde

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

A2 fija Traefik (o Nginx si se justifica) como proxy de borde, que debe servir el frontend en `/` y enrutar `/api/*` al backend bajo el mismo origen. Traefik es un proxy inverso: no sirve archivos estáticos, así que haría falta otro contenedor para el frontend. EnvioTec es solo interno y el certificado lo emite la CA de la organización, por lo que las ventajas principales de Traefik (certificados ACME automáticos y descubrimiento dinámico) no aplican.

## Decisión

Usar Nginx (imagen sin privilegios, versión fijada) como único componente de borde: TLS con el certificado de la CA interna, archivos estáticos, proxy de `/api/*` y headers de seguridad de A8 en un solo lugar. La ruta de vista previa de plantillas tiene su propio bloque `location` con su CSP (ADR-012).

## Alternativas descartadas

- **Traefik + contenedor de estáticos:** un componente más sin beneficio en una red interna.
- **Backend sirviendo estáticos (`@fastify/static`):** mezcla responsabilidades y agrega una dependencia.

## Consecuencias

- Menos componentes; headers definidos en un solo archivo de configuración versionado.
- La renovación del certificado de la CA interna es manual o la hace infraestructura; va en el runbook.
- `trustProxy` del backend se configura con la IP de Nginx en la red `edge`.
