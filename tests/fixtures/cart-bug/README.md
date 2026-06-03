# Vault Cart — demo de race condition / estado acumulado para mypry

App Next.js mínima con un **bug que NO se puede encontrar leyendo el código**: solo
aparece tras una secuencia concreta de acciones y vive en el estado de runtime del
servidor. Pensada para grabar una demo de [mypry](https://www.npmjs.com/package/mypry)
donde el agente pausa, inspecciona el objeto vivo y encuentra lo que ningún grep revela.

## Por qué este bug sí justifica un debugger

Cada handler (`add`, `coupon`, `clear`, `total`) es **individualmente correcto**. El cálculo
del total es impecable. No hay ninguna línea "mala" que un agente pueda detectar leyendo.
El bug es **estado que sobrevive entre peticiones** en un singleton en memoria, y solo se
manifiesta con una secuencia específica. La causa solo existe en runtime → hay que pausar
y mirar el objeto vivo.

## El bug (no lo cuentes en la demo; es lo que el agente debe descubrir)

El carrito vive en un `Map` en memoria del servidor (`lib/cart-store.ts`), indexado por
`sessionId`. El handler `clearCart` vacía `items` pero **deja `discountPct` y `couponCode`
intactos** — con un comentario que lo racionaliza ("el cupón se gestiona en su propio
endpoint"). Suena razonable leyéndolo aislado.

Secuencia que lo dispara:

1. Añadir Keyboard ($120) + Mouse ($45)
2. Aplicar cupón **SAVE25** (−25%)  → total 123.75, correcto
3. **Vaciar carrito**               → items vacíos, pero el 25% sigue pegado al objeto
4. Añadir **solo un Desk Mat ($25)** → total **18.75** en vez de **25.00**

El usuario nunca aplicó un cupón a este carrito nuevo, pero le descuentan 25%. Un carrito
en otra sesión está limpio, lo que demuestra que el problema es el estado acumulado, no el
código.

## Arrancar

```bash
npm install
NODE_OPTIONS='--inspect=9229' npx next dev
# Next en http://localhost:3000
# Inspector V8: el parent se toma 9229, el router server (donde corren los routes) abre en 9230
```

> **Importante:** Next.js 14 lanza las API routes en un proceso hijo (el "router server").
> El `--inspect` del parent no cubre ese proceso. `NODE_OPTIONS` fuerza `--inspect` en
> todos los hijos. El router se anuncia en el log como `port 9230`.
> Conecta mypry al **9230** — es donde viven los handlers y donde resuelve el breakpoint.

## Reproducir a mano (el "antes")

Abre http://localhost:3000 y pulsa en orden: **+Keyboard**, **+Mouse**, **Aplicar SAVE25**,
**Vaciar carrito**, **+Desk Mat**, **Recalcular total**. Verás un Desk Mat de $25 cobrado a
$18.75 con un descuento del 25% que no aplicaste. Desconcertante: "pero si vacié el carrito".

## Guion para el agente (lo que tecleas en el chat)

> El total del carrito sale mal a veces. Si añado cosas, aplico un cupón, vacío el carrito y
> vuelvo a añadir un producto, me aplica un descuento que ya no debería existir. No encuentro
> dónde está el fallo, cada función parece correcta. ¿Puedes depurarlo?

Flujo esperado de herramientas mypry:

```
debugger_connect        { port: 9230, frontend: "http://localhost:3000" }
debugger_set_breakpoint { file: "app/api/cart/total/route.ts", line: 9 }   # condición opcional abajo
debugger_snapshot   # IMPORTANTE: usa los selectores que devuelve el snapshot,
                    # los de abajo son orientativos (texto de cada boton)

# Reproducir la secuencia desde el browser
debugger_browse { script: 'click "button + Keyboard $120"\nclick "button + Mouse $45"\nclick "button Aplicar SAVE25"\nclick "button Vaciar carrito"\nclick "button + Desk Mat $25"\nclick "button Recalcular total"' }
  # -> backend pausa en total/route.ts:9

# Inspeccionar el objeto VIVO: aquí está la pista que el código no muestra
debugger_eval { expr: "cart" }
  # -> { items: [ Desk Mat x1 ], discountPct: 25, couponCode: "SAVE25" }  <-- descuento fantasma
debugger_eval { expr: "cart.items.length" }    # -> 1  (solo el Desk Mat)
debugger_eval { expr: "cart.discountPct" }      # -> 25 (no debería: este carrito no tiene cupón)
debugger_eval { expr: "cart.couponCode" }       # -> "SAVE25"  sobrevivió al vaciado
debugger_continue
```

**Breakpoint condicional opcional** (más elegante para la demo): para que pause solo en el
caso roto y no en cada total:

```
debugger_set_breakpoint {
  file: "app/api/cart/total/route.ts",
  line: 9,
  condition: "cart.items.length > 0 && cart.discountPct > 0 && cart.items.every(i => i.sku !== 'KEY')"
}
```

(es decir: hay items, hay descuento, pero el carrito ya no contiene lo que se compró con el cupón).

Diagnóstico que debería dar el agente: `clearCart` en `lib/cart-store.ts` resetea `items`
pero no `discountPct` ni `couponCode`; como el carrito es un singleton en memoria, el
descuento persiste para la siguiente compra de la misma sesión.

## La corrección (el "después")

En `lib/cart-store.ts`, que `clearCart` resetee todo el estado:

```ts
export function clearCart(sessionId: string): void {
  const cart = getCart(sessionId);
  cart.items = [];
  cart.discountPct = 0;
  cart.couponCode = null;
}
```

Repite la secuencia → el Desk Mat vuelve a costar $25.

## Variante "solo backend"

Salta `debugger_browse` y dispara la secuencia con `curl`/Postman (cuatro POST con el mismo
`sessionId`: add KEY, add MSE, coupon SAVE25, clear, add PAD, total). El breakpoint pausa
igual y el `cart` vivo muestra el descuento fantasma.
