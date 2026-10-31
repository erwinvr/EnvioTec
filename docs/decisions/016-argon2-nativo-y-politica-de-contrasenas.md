# ADR-016: Argon2id nativo y política de contraseñas

- **Estado:** Aceptado (2026-10-31)
- **Fecha:** 2026-10-31

## Contexto

A5 exige Argon2id con parámetros configurables, rehash al cambiar los parámetros y rechazo de contraseñas comunes con una lista local. La Fase 0 previó el paquete `argon2` solo si Node.js no ofrecía una implementación estable. Node.js 26 incluye `crypto.argon2()` y no emite aviso de API experimental.

## Decisión

- **Hash:** `crypto.argon2('argon2id', …)` nativo, con sal aleatoria de 16 bytes y salida de 32 bytes, guardado en formato PHC (`$argon2id$v=19$m=…,t=…,p=…$sal$hash`). Parámetros por defecto: m = 19 456 KiB, t = 2, p = 1 (mínimo recomendado por OWASP), configurables con `ARGON2_*`, sin permitir valores menores. La verificación compara en tiempo constante (`timingSafeEqual`) e indica si hace falta rehash.
- **Entrada:** como máximo 1024 bytes, para que una contraseña enorme no sirva para DoS.
- **Política** (`core/auth/password-policy.js`): de 12 a 128 caracteres, sin reglas de composición ni vencimiento forzado. Se rechaza una contraseña que:
  - figura en la lista de las 10.000 más comunes de SecLists (MIT), o es una palabra de esa lista rodeada de números o símbolos (`Password2026!`);
  - tiene menos de 5 caracteres distintos;
  - contiene el usuario, la parte local del email o el nombre de la aplicación.
- La lista vive en `backend/src/core/auth/data/` con su licencia, su origen y su SHA-256.

## Alternativas descartadas

- **Paquete `argon2`:** binario nativo que hay que compilar; ya no aporta nada frente a la implementación de Node.
- **Solo la lista exacta:** con un mínimo de 12 caracteres casi ninguna entrada de la lista aplica (solo 10 de 10 000), por eso se agregan las variantes con números o símbolos.
- **Consulta a Have I Been Pwned:** la Parte B no la habilita y la app no sale a internet salvo hacia Mandrill.

## Consecuencias

- Cambiar los parámetros de Argon2 no invalida los hashes existentes: se rehashean en el siguiente login (Fase 3).
- La lista se actualiza reemplazando el archivo y su SHA-256 en el README de la carpeta.
