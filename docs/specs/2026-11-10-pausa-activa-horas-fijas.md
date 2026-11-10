# Pausa activa a horas fijas

Fecha: 2026-11-10. Extensión 0.2.22. Sigue a 2026-10-22-pausa-activa-veces-al-dia.

## Pedido

Lukas: "me parece que hay que agregar en la configuración el poder elegir las horas".

## Qué cambia

- Nueva frecuencia **"A horas fijas"** en la página Pausa activa del portal, además de
  "Según el trabajo continuo" y "Veces al día".
- El admin elige de 1 a 8 horas (`HH:MM`, hora de Chile). Son las mismas para todo el equipo.
- `config/org`: `activeBreakMode: 'times'` y `activeBreakTimes: string[]` (ordenadas, sin repetir).
  Las reglas validan la lista: 1–8 elementos, cada uno `HH:MM` 24 h.
- La extensión avisa a cada hora elegida mientras mide la jornada. Si a esa hora la persona está en
  colación, fuera de su horario o sin jornada, ese aviso no llega (igual que en "Veces al día"). Si está
  en una reunión o fuera del computador, el aviso llega cuando vuelve, y el siguiente no antes de 30 min.
- El ejercicio de cada pausa es el del plan del día (`dailyExercise(fecha, índice, cantidad de horas)`),
  el mismo para todos.
- El plan de pausas del portal muestra "Pausa N · HH:MM: ejercicio" y, por persona, solo las horas que
  caen dentro de su horario. La línea de tiempo del colaborador marca las pausas previstas.
- El popup dice "Pausas de 5 min a las 11:00 y 16:00".

## Compatibilidad

- Un `config/org` con `activeBreakMode: 'times'` sin horas válidas se lee como "Según el trabajo continuo".
- Las extensiones anteriores a 0.2.22 leen `times` como "Según el trabajo continuo" hasta actualizarse.
- Las reglas nuevas deben desplegarse antes de guardar el modo nuevo (antes, el guardado se rechaza).
