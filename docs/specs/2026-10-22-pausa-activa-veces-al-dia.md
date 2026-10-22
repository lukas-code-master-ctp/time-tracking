# Spec — Pausa activa: x veces al día

Fecha: 2026-10-22 · Extensión 0.2.8 · Sigue a [2026-10-21-pausa-activa](2026-10-21-pausa-activa.md)

## Qué pidió el usuario
Además de "cada x minutos de trabajo continuo", poder configurar la pausa activa como **x veces al día** (o ambas posibilidades).

## Configuración (`config/org`, portal → Configuración → Pausa activa)
Se agrega el selector **Frecuencia**: "Según el trabajo continuo" (lo de 0.2.7) o "Veces al día". Con "Veces al día", el selector "Cada cuánto" se reemplaza por "Veces al día" (2 a 6).

| Campo | Tipo | Valores | Por defecto |
|---|---|---|---|
| `activeBreakMode` | string | `'interval'` \| `'daily'` | `'interval'` (campo ausente) |
| `activeBreaksPerDay` | int | portal: 2–6 · reglas: 1–12 | 3 |

El portal escribe estos dos campos solo en modo `daily`, así que guardar en modo "trabajo continuo" sigue funcionando con las reglas de 0.2.7. También guarda `activeBreakIntervalMinutes`, así que una extensión 0.2.7 que aún no se actualiza sigue avisando por trabajo continuo.

## Cuándo avisa en modo `daily` (extensión)
- Las `n` pausas se reparten en partes iguales dentro del **tiempo de trabajo del día**: el horario de la persona (excepción o general), sin la colación. El tiempo se divide en `n + 1` partes y cada aviso cae al final de una parte (`dailyBreakTargets`). Ejemplo: 09:00–18:00, colación 13:00–14:00 y 3 al día dan 11:00, 14:00 y 16:00.
- **Sin horario** configurado, se reparten en 9 horas desde que se inició la jornada.
- Un objetivo que pasa con la jornada cerrada o fuera del horario se **descarta**. Por ejemplo, si la jornada se inicia a las 15:00, solo queda el de las 16:00.
- Si la persona estuvo **alejada** (inactiva o con el equipo suspendido) lo que dura la pausa cuando pasó el objetivo, ya cuenta como pausa y ese aviso se descarta. Si la ausencia fue más corta, el aviso llega apenas vuelve.
- Durante una **reunión web** espera a que termine.
- Entre dos avisos pasan al menos **30 minutos**: si uno se atrasó, el siguiente se corre.
- "En 10 min" lo repite 10 minutos después. "Tomé la pausa" y el resto de las respuestas funcionan igual que en 0.2.7, y se guardan en `breaks` del mismo modo.

El popup muestra "3 pausas de 5 min al día, repartidas en tu horario" y la hora aproximada de la próxima.

## Despliegue
1. `npx firebase deploy --only firestore:rules --project prod`: las reglas aceptan los dos campos nuevos. Hasta desplegarlas, guardar en modo "Veces al día" falla con permiso denegado, y el modo de trabajo continuo funciona igual.
2. Merge: el portal se publica en Vercel y la extensión 0.2.8 se sube a la tienda.
