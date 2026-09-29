# Plan — Varios dominios permitidos

Spec: `docs/specs/2026-09-29-multi-dominio.md`.

Una sola tarea (el cambio atraviesa todos los paquetes y debe quedar consistente), implementada por un subagente y revisada por otro.

## Tarea única
1. `packages/shared`: tipo `OrgConfig.allowedDomains`, `isAllowedEmail` con lista, `parseDomainList`, `readAllowedDomains(config)` (tolera `allowedDomain` antiguo), `resolveConfig` con lista, `defaultOrgConfig(now, domains, updatedBy)`, default `['impulseai.cl','compratuparcela.cl']`, helper de texto `formatDomains(domains)` → "@a o @b". Tests.
2. `firestore.rules` + tests de reglas.
3. `functions`: `joinOrg` y env; `.env.demo-timetracking` (`ALLOWED_DOMAIN=impulseai.cl,compratuparcela.cl`, `BOOTSTRAP_ADMINS=lukas@impulseai.cl`); tests.
4. `extension`: mensajes con lista; `.env.*`; tests.
5. `portal`: Configuración (editor de lista), Invitaciones, login `hd`; payloads; `.env.*`; tests.
6. `scripts` (seed, e2e, helpers) y e2e de extensión/portal: admin `lukas@impulseai.cl`, colaboradores en ambos dominios.
7. README y spec original: reemplazar referencias al dominio único y a `jefa@`; OAuth Externa, Web Store no listada, instalación forzada por organización.
8. Verificación: `npm run typecheck`, `npm test`, `npm run test:emulator`, `npm run build`, `npm run e2e`, `npm run e2e:portal`, `npm run e2e:extension`.
