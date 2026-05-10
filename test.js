'use strict'

const pry = require('../lib/pry')

function calcularPrecio(cantidad, precioUnitario) {
  const subtotal = cantidad * precioUnitario

  pry()  // ⇽ pausa acá, igual que binding.pry

  const impuesto = subtotal * 0.21
  return subtotal + impuesto
}

const resultado = calcularPrecio(5, 100)
console.log('Total:', resultado)
