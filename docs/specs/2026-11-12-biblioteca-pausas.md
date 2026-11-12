# Biblioteca de pausas activas con animaciones

Fecha: 2026-11-12. Extensión 0.2.26. Sigue a 2026-10-21-pausa-activa y 2026-11-10-pausa-activa-horas-fijas.

## Pedido

Lukas: "después de una semana se vuelven genéricas". Había 8 ejercicios de solo texto en rotación fija: con
3 pausas al día cada uno volvía cada 2 o 3 días. Se compararon IA en vivo (OpenRouter), videos de YouTube y
una biblioteca propia; Lukas eligió la biblioteca grande con animaciones y aprobó el listado de 56 ejercicios
(documento "Biblioteca de pausas activas", 2026-11-12).

## Qué cambia

- `packages/shared/src/exercises.ts`: 56 ejercicios en 7 zonas (cuello y hombros, vista, manos y muñecas,
  espalda y pecho, piernas, respiración, movilidad), 8 por zona, con postura y dibujo. Los 8 anteriores
  siguen con los mismos ids y textos (los ids viven en `breaks/{id}.exercise`: nunca cambiarlos).
- Rotación (`exerciseAt(n)`): cada vuelta de 56 recorre todos sin repetir, barajados de forma distinta en
  cada vuelta (semilla fija: igual en todos los equipos), y siempre en el orden de zonas de `EXERCISE_ZONES`,
  así que 7 pausas seguidas son de 7 zonas distintas. Entre vueltas, los dos primeros de una zona nunca son
  los dos últimos de la vuelta anterior. "Veces al día" y "A horas fijas" siguen usando
  `dailyExercise(fecha, índice, cantidad)`: el mismo ejercicio para todo el equipo.
- `packages/shared/src/exerciseArt.ts`: cada ejercicio se dibuja como SVG animado con CSS (figura de
  palitos, ojo, mano o círculo de respiración con los segundos). Sin scripts ni imágenes externas. Usa
  `--accent` y `--accent-soft`, funciona en claro y oscuro, y con `prefers-reduced-motion` queda quieto en
  la primera pose. La animación sigue donde iba aunque el popup se redibuje cada 2 s.
- Popup: la tarjeta "Pausa activa" pendiente muestra la animación junto al texto.
- Portal, página Pausa activa: el plan del día muestra la animación de cada pausa y la sección Ejercicios
  muestra la biblioteca por zona.

## Compatibilidad

- No cambian reglas ni datos. Un id nuevo en una extensión antigua (o al revés) cae en el texto genérico
  ("Levántate y estira el cuerpo unos minutos").
- Al actualizar, el plan del día cambia de ejercicio (nueva rotación). La notificación sigue siendo solo texto.
