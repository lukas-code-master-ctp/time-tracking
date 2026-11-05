# Cumpleaños y aniversarios del equipo (2026-11-05)

Pedido de Lukas (idea 6 de la lista de RRHH): un aviso en el popup de la extensión con los cumpleaños y aniversarios laborales del equipo.

## Datos

`celebrations/{uid}` (uno por persona, id = uid de `users`):

| campo | tipo | notas |
|---|---|---|
| `displayName` | string ≤ 200 | copia del nombre (los colaboradores no pueden leer `users` de otros) |
| `birthday` | `MM-DD` o null | sin año: la edad nunca se guarda. El 29 de febrero se celebra el 28 en años no bisiestos |
| `hireDate` | `YYYY-MM-DD` o null | fecha de ingreso; no futura. El aniversario cuenta desde el primer año cumplido |
| `active` | bool | copia de `users/{uid}.status == 'active'`; desactivar/activar una cuenta en el portal lo actualiza |
| `updatedAt`, `updatedBy` | int, uid del admin | |

Reglas: lee cualquier persona activa; escribe y borra solo un admin activo, y solo para un `users/{uid}` existente.

Lógica pura en `packages/shared/src/celebrations.ts` (`upcomingCelebrations`, `validateCelebration`, `readCelebration`).

## Portal

Colaboradores › **Cumpleaños** (`/colaboradores/fechas`): "Próximas fechas" de los 30 días siguientes y, por persona, día y mes del cumpleaños y fecha de ingreso con su botón Guardar.

## Extensión (0.2.14)

- Lee `celebrations` junto con `config/org` como mucho cada 3 horas (caché `tt.meta.celebrations`, se borra al cerrar sesión). Sin las reglas desplegadas la lectura se rechaza y no se muestra nada.
- El popup muestra, bajo la pausa activa, una fila con la fecha más próxima de hoy a 7 días (destacada si es hoy: "Hoy es el cumpleaños de Ana", "¡Feliz cumpleaños!" si es la propia persona). Si hay más, un "+N" despliega el resto. Una sola fila para no pasar los 600 px del popup.
- Sin fechas en los próximos 7 días no aparece nada.
